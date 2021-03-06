var Walker = require('walker');
var fs = require('fs');
var crypto = require('crypto');
var path = require('path');
var Q = require('q');
var id3 = require('id3js');
var util = require('util');
var ExifImage = require('exif').ExifImage;

var list = [];
var duplicates = {};
var entries = {};

var CONFIG_DIR = '~/.syno-inventory';
var CONFIG_FILE = 'config.json';
var DATA_FILE = 'inventory.json';

var opt = {
  forceGenSha1: false,
  forceGenId3: false,
  forceGenExif: false
};

function pathSubstituteHome(name) {
  return name.replace(/^~/, process.env.HOME);
}

function loadConfig() {
  var configname = path.normalize(path.join(CONFIG_DIR, CONFIG_FILE));
  configname = pathSubstituteHome(configname);
  var config = fs.readFileSync(configname, {});
  config = JSON.parse(config);
  var dirs = {};

  config.exclude = config.exclude || [];

  config.directories.forEach(function(entry) {
    var name = entry.dir;
    entry.dir = pathSubstituteHome(path.normalize(entry.dir));
    entry.dir = entry.dir.replace(/\/$/, '');

    if (dirs[entry.dir]) {
      console.log("ERROR: duplicate entry: ", name);
      process.exit();
    } else {
      dirs[entry.dir] = entry;
    }

    entry.exclude = entry.exclude || [];
    entry.exclude = entry.exclude.concat(config.exclude);
  });

  return config;
}

function walk(config) {

  console.log("Walk: ", config);
  var deferred = Q.defer();

  Walker(path.join(config.dir))
    .filterDir(function(dir, stat) {
      if (config.exclude.indexOf(path.basename(dir)) >= 0) {
        console.warn('Skipping dir', dir);
        return false;
      }

      return true;
    })
    .on('entry', function(entry, stat) {
      // console.log('Got entry: ' + entry)
    })
    .on('dir', function(dir, stat) {
      console.log('Got directory: ' + dir);
    })
    .on('file', function(file, stat) {
      var name = path.relative(config.dir, file);
      if (excludeFile(file, config)) {
        console.log('Skipping file: ' + name);
      } else {
        var entry = entries[file];
        var newentry = {
            dir: config.dir,
            name: name,
            size: stat.size,
            ctime: stat.ctime,
            mtime: stat.mtime
          };

        if (entry) {
          console.log("Existing:", file);
          var stat2 = {mtime: stat.mtime, ctime: stat.ctime};
          stat2 = JSON.parse(JSON.stringify(stat2));

          if (entry.size !== stat.size ||
            entry.mtime != stat2.mtime ||
            entry.ctime != stat2.ctime) {
            console.log("File changed:", entry, stat2);
            list.push(newentry);
          } else {
            list.push(entry);
          }
          delete entries[file];
        } else {
          console.log("New file:", file);
          list.push(newentry);
        }
      }
    })
    .on('symlink', function(symlink, stat) {
      console.log('Got symlink: ' + symlink);
    })
    .on('blockDevice', function(blockDevice, stat) {
      console.log('Got blockDevice: ' + blockDevice);
    })
    .on('fifo', function(fifo, stat) {
      console.log('Got fifo: ' + fifo);
    })
    .on('socket', function(socket, stat) {
      console.log('Got socket: ' + socket);
    })
    .on('characterDevice', function(characterDevice, stat) {
      console.log('Got characterDevice: ' + characterDevice);
    })
    .on('error', function(er, entry, stat) {
      console.log('Got error ' + er + ' on entry ' + entry);
      deferred.reject('Got error ' + er + ' on entry ' + entry);
    })
    .on('end', function() {
      console.log('All files traversed.', config.dir);
      deferred.resolve();
    });

    return deferred.promise;
}

function extractId3() {
    console.log("======= Extract ID3 info");
    var result = Q(1);

    list.forEach(function(entry) {
      if (/.mp3$/.test(entry.name) && ( ! entry.id3 || opt.forceGenId3)) {
        result = result.then(function() {

          console.log('ID3:', entry.name);
          var deferred = Q.defer();

          id3({ file: path.join(entry.dir, entry.name), type: id3.OPEN_LOCAL }, function(err, tags) {
            if (err) {
              console.log('ID3 error', err);
              deferred.reject(err);
              return;
            }

            // tags now contains your ID3 tags
            addId3Info(entry, tags);
            // console.log('ID3', tags);
            deferred.resolve();
          });

          return deferred.promise;
        });
      }
    });
    return result;
}

function extractExif() {
    console.log("======= Extract Exif data");
    var result = Q(1);

    list.forEach(function(entry) {
      if (/\.jpg$/i.test(entry.name) && ( ! entry.exif || opt.forceGenExif)) {
        result = result.then(function() {

          console.log('Exif:', entry.name);
          var deferred = Q.defer();

          new ExifImage({image : path.join(entry.dir, entry.name)}, function(err, exif) {
            if (err) {
              console.log('Exif error', err);
              deferred.reject(err);
              return;
            }

            delete exif.thumbnail;
            delete exif.exif.MakerNote;
            delete exif.exif.UserComment;
            delete exif.gps.GPSProcessingMethod;
            delete exif.gps.GPSVersionID;
            delete exif.interoperability;
            delete exif.makernote;
            // console.log('Exif', exif);
            entry.exif = exif;
            deferred.resolve();
          });

          return deferred.promise;
        });
      }
    });
    return result;
}

function computeAllSha1() {
    console.log("======= Compute SHA1");
    var result = Q(1);

    list.forEach(function(entry) {
      if (( ! entry.sha1) || opt.forceGenSha1) {
        result = result.then(function() {
          return computeSha1(entry);
        });
      }
    });
    return result;
}

function processAllDirs() {
    console.log("======= Process all dirs");

    var config = loadConfig();
    var result = Q(1);

    // Queue all the directories to process
    config.directories.forEach(function(entry) {
      if (entry.enabled) {
        result = result.then(function() {
          return walk(entry);
        });
      }
    });
    return result;
}

function addId3Info(entry, tags) {
  var id3 = {};
  var items = ['title', 'artist', 'album', 'year'];
  items.forEach(function(key) {
    if (tags[key]) {
      id3[key] = tags[key].replace(/\u0000/g, '');
    }
  });
  entry.id3 = id3;
}

function excludeFile(file, config) {
  var found = false;
  config.exclude.forEach(function(pattern) {
    // console.log('Checking', file, 'with pattern >>' + pattern + '<<');
    var patt = new RegExp(pattern);
    if (patt.test(file)) {
      found = true;
    }
  });
  return found;
}

function computeSha1(entry) {
  var filename = path.join(entry.dir, entry.name);
  // console.log('Compute SHA1:', filename);
  var deferred = Q.defer();
  var shasum = crypto.createHash('sha1');

  var s = fs.ReadStream(filename);
  s.on('data', function(d) {
    shasum.update(d);
  });

  s.on('end', function() {
    var d = shasum.digest('hex');
    console.log('SHA1', d + '  ' + filename);
    entry.sha1 = d;
    deferred.resolve(d);
  });

  return deferred.promise;
}

function detectDuplicates() {
  console.log('Detect duplicates');
  var sha1s = {};
  list.forEach(function(entry) {
    var sha1 = entry.sha1;
    if (entry.size > 0 && sha1s[sha1]) {
      duplicates[sha1] = sha1s[sha1];
      sha1s[sha1].push(path.join(entry.dir, entry.name));
    } else {
      sha1s[sha1] = [path.join(entry.dir, entry.name)];
    }
  });
}

function storeResults() {
  var filename = path.normalize(path.join(CONFIG_DIR, DATA_FILE));
  filename = pathSubstituteHome(filename);

  // TODO: should we keep the previous one ?

  return Q.nfapply(fs.writeFile, [filename, JSON.stringify(list, null, 2), {encoding: 'utf8'}]);
}

function loadInventory() {
  var filename = path.normalize(path.join(CONFIG_DIR, DATA_FILE));
  filename = pathSubstituteHome(filename);

  var result = Q.nfapply(fs.readFile, [filename, {encoding: 'utf8'}]);
  return result.then(doTheJob, ignoreAndContinue);

  function ignoreAndContinue() {
    // Just ignore and continue
    console.log("No previous file");
  }

  function doTheJob() {
    var result = Q.nfapply(fs.readFile, [filename, {encoding: 'utf8'}]);
    return result.then(function(value) {
      // console.log("DATA:", value);
      var values = JSON.parse(value);
      values.forEach(function(item) {
        entries[path.join(item.dir, item.name)] = item;
      });
    });
  }
}

function bye() {
  console.log('DONE');
}

function main() {
  var result = Q(1);

  result.then(loadInventory)
    .then(processAllDirs)
    .then(extractId3)
    .then(extractExif)
    .then(computeAllSha1)
    .then(detectDuplicates)
    .then(displayResults)
    .then(storeResults)
    .then(bye)
    .done();
}

function displayResults() {
  console.log('List:', list);
  console.log('Duplicates:', util.inspect(duplicates, {depth: 2}));
  console.log('Removed files:', util.inspect(entries, {depth: 2}));
}

main();

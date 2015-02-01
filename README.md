syno-inventory
==============

### Config file

Must be ~/.syno-inventory/config.json

### Config example

{
	"exclude": [
  				".svn"
  			],
	"directories": [
  		{
  			"dir": "~/GIT/synology/syno-inventory-test",
  			"enabled": true,
  			"exclude": [
  				"\\.bak$"
  			]
  		},
  		{
  			"dir": "~/GIT/synology/syno-inventory-test-2",
  			"enabled": false
  		}
	]
}

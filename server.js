var metalsmith = require('metalsmith')
var serve = require('metalsmith-serve')
var watch = require('metalsmith-watch')

var config = require('./metalsmith.json')

var build = metalsmith(__dirname)

Object.keys(config.plugins).forEach(function(pluginName) {
  var plugin = require(pluginName)

  build.use(plugin(config.plugins[pluginName]))
})

build.use(serve())
build.use(watch({
  paths: {
    "${source}/**/*": "**/*",
    "public/**/*": true,
    "templates/**/*": "**/*"
  }
}))

build.build(function(error) {
  if (error) {
    throw error
  }
})

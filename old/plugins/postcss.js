var postcss = require('postcss')
var cssnext = require('cssnext')
var autoprefixer = require('autoprefixer')
var pixrem = require('pixrem')
var mixins = require('postcss-mixins')
var nested = require('postcss-nested')
var cssnano = require('cssnano')
var path = require('path')

module.exports = function(opts) {
  return function(files, metalsmith, done) {
    var styles = Object.keys(files)
      .filter(function(file) {
        return /\.css$/.test(file)
      })

    var count = styles.length

    styles
      .forEach(function(file) {
        var outFile = path.join(metalsmith.destination(), file)
        var plugins = [
          cssnext(),
          autoprefixer(),
          pixrem(),
          mixins(),
          nested(),
          cssnano()
        ]

        postcss(plugins)
          .process(files[file].contents.toString(), {from: file})
          .then(function (result) {
            delete files[file]
            files[outFile] = {
              contents: new Buffer(result.css)
            }

            if (--count === 0) {
              done()
            }
          })
      })
  }
}

'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol && obj !== Symbol.prototype ? "symbol" : typeof obj; };

exports.default = WebpackMultiOutput;

var _fs = require('fs');

var _fs2 = _interopRequireDefault(_fs);

var _path = require('path');

var _path2 = _interopRequireDefault(_path);

var _crypto = require('crypto');

var _mkdirp = require('mkdirp');

var _mkdirp2 = _interopRequireDefault(_mkdirp);

var _lodash = require('lodash.clone');

var _lodash2 = _interopRequireDefault(_lodash);

var _lodash3 = require('lodash.merge');

var _lodash4 = _interopRequireDefault(_lodash3);

var _webpackSources = require('webpack-sources');

var _async = require('async');

var _ModuleFilenameHelpers = require('webpack/lib/ModuleFilenameHelpers');

var _FasterReplaceSource = require('./FasterReplaceSource');

var _FasterReplaceSource2 = _interopRequireDefault(_FasterReplaceSource);

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

var baseAssets = {
  filename: 'assets.json',
  path: '.',
  prettyPrint: false
};

function WebpackMultiOutput() {
  var options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

  this.options = (0, _lodash4.default)({
    values: [],
    debug: false,
    ultraDebug: false,
    uglify: false,
    replaceResourcePath: function replaceResourcePath(resourcePath, value) {
      var ext = _path2.default.extname(resourcePath);
      var basename = _path2.default.basename(resourcePath, ext);
      return resourcePath.replace('' + basename + ext, '' + value + ext);
    },
    sourceMaps: {}
  }, options);

  this.options.assets = _typeof(options.assets) === 'object' ? (0, _lodash4.default)(baseAssets, options.assets) : false;

  this.addedAssets = [];
  this.assetsMap = {};
  this.chunksMap = {};
  this.chunkName = '';
  this.chunkHash = '';
  this.filePathRe = /WebpackMultiOutput-(.*?)-WebpackMultiOutput/;
  this.filePathReG = /WebpackMultiOutput-(.*?)-WebpackMultiOutput/g;
  this.jsonpRe = /__WEBPACK_MULTI_OUTPUT_CHUNK_MAP__/;
}

function findAllOccurrences(str, find) {
  var regex = new RegExp(find, 'g');
  var indices = [];
  var result = void 0;
  while (result = regex.exec(str)) {
    indices.push(result.index);
  }

  return indices;
}
function replaceSnippetOnSource(source, match, replacement) {
  var original = source._source.source();
  var indexes = findAllOccurrences(original, match);
  // we substract 1 out of the length given that the string pos starts in 0 :P
  var offset = match.length - 1;

  if (indexes.length) {
    indexes.forEach(function (from) {
      source.replace(from, from + offset, '');
      source.insert(from, replacement);
    });
    return true;
  }
  return false;
}

WebpackMultiOutput.prototype.apply = function (compiler) {
  var _this = this;

  compiler.plugin('compilation', function (compilation) {
    compilation.__webpackMultiOutput = true;

    if (_path2.default.extname(compilation.outputOptions.filename) === '.js' && !_this.needsHash) {
      _this.needsHash = /\[hash\]/.test(compilation.outputOptions.filename);
    }

    if (!_this.options.values.length) {
      compilation.errors.push(new Error('[webpack-multi-output] Error: option "values" must be an array of length >= 1'));
    }

    compilation.plugin('optimize-chunk-assets', function (chunks, callback) {
      (0, _async.forEachOfLimit)(chunks, 5, function (chunk, y, chunkCallback) {
        (0, _async.forEachOfLimit)(chunk.files, 5, function (file, k, fileCallback) {
          if (_path2.default.extname(file) !== '.js') {
            return (0, _async.setImmediate)(fileCallback);
          }

          var source = compilation.assets[file];

          // ignore files with no code the replace
          // and no jsonp script
          if (!_this.filePathReG.test(source.source()) && !_this.jsonpRe.test(source.source())) {
            _this.log('Ignoring asset ' + file + ', no replacement to process', 'ultra');
            return (0, _async.setImmediate)(fileCallback);
          }

          (0, _async.forEachOfLimit)(_this.options.values, 5, function (value, l, languageCallback) {
            var basename = _path2.default.basename(file, '.js');
            var filename = value + '.' + basename + '.js';
            var sourceMapFilename = filename + '.map';

            _this.processSource(value, (0, _lodash2.default)(source), function (result) {
              _this.log('Add asset ' + filename);
              compilation.assets[filename] = result;

              _this.chunksMap[chunk.id] = true;
              _this.addedAssets.push({ value: value, filename: filename, name: chunk.name });

              if ((0, _ModuleFilenameHelpers.matchObject)(_this.options.sourceMaps, filename)) {
                var sourceMap = result.map();

                if (sourceMap.mappings) {
                  chunk.files.push(filename);
                  compilation.assets[sourceMapFilename] = new _webpackSources.RawSource(JSON.stringify(sourceMap));
                }
              }

              if (chunk.name) {
                if (_this.needsHash) {
                  _this.chunkHash = compilation.getStats().hash;
                }
                _this.chunkName = chunk.name;
                _this.addToAssetsMap(value, chunk.name, 'js', '' + compilation.outputOptions.publicPath + filename);
              }

              return (0, _async.setImmediate)(languageCallback);
            }, filename);
          }, fileCallback);
        }, chunkCallback);
      }, callback);
    });

    compilation.plugin('optimize-assets', function (assets, callback) {
      var length = _this.chunkHash.length;

      (0, _async.forEachOfLimit)(_this.addedAssets, 5, function (_ref, index, assetCallback) {
        var value = _ref.value,
            filename = _ref.filename,
            name = _ref.name;

        var source = _this.replaceChunkMap(compilation.assets[filename]);

        if (!_this.needsHash) {
          compilation.assets[filename] = source;
          return (0, _async.setImmediate)(assetCallback);
        }

        var fileHash = (0, _crypto.createHash)('md5').update(source.source()).digest('hex').substr(0, length);
        var newFilename = filename.replace(_this.chunkHash, fileHash);

        _this.log('Update hash in filename for ' + filename + ' -> ' + newFilename, 'ultra');

        if (filename !== newFilename) {
          compilation.assets[newFilename] = source;
          delete compilation.assets[filename];
          _this.addToAssetsMap(value, name, 'js', '' + compilation.outputOptions.publicPath + newFilename);
        }

        assetCallback();
      }, callback);
    });

    compilation.mainTemplate.hooks.render.tap({
      name: "JsonpMainTemplatePlugin chunkId replacement",
      stage: Infinity
    }, function (rawSource) {
      var sourceString = rawSource.source();
      if (!sourceString.includes('jsonpScriptSrc')) {
        return rawSource;
      } else {
        // HACK: Find the line containing `jsonpScriptSrc`, which looks like 
        // /******/ 	function jsonpScriptSrc(chunkId) {
        // /******/ 		return __webpack_require__.p + "" + ({$CHUNK_ID_TO_NAME_MAP}[chunkId]||chunkId) + ".js"
        // /******/ 	}
        // and replace `chunkId` with `webpackMultiOutputGetChunkId(chunkId)`, which attaches the locale 
        // [specified in `__WEBPACK_MULTI_OUTPUT_CHUNK_MAP__`] if necessary.
        var sourceArray = sourceString.split('\n');

        var chunkIdModifier = 'var webpackMultiOutputGetChunkId = function(chunkId) {\n          var map = {__WEBPACK_MULTI_OUTPUT_CHUNK_MAP__:2};\n          return map[chunkId] ? \'__WEBPACK_MULTI_OUTPUT_VALUE__.\' + chunkId : chunkId;\n        };\n        ';
        var jsonpScriptSrcFunctionIndex = sourceArray.findIndex(function (a) {
          return a.includes('jsonpScriptSrc');
        });

        sourceArray[jsonpScriptSrcFunctionIndex + 1] = sourceArray[jsonpScriptSrcFunctionIndex + 1].replace('chunkId', 'webpackMultiOutputGetChunkId(chunkId)');
        sourceArray.splice(jsonpScriptSrcFunctionIndex + 1, 0, chunkIdModifier);

        return sourceArray.join('\n');
      }
    });
  });

  compiler.plugin('after-emit', function (compilation, callback) {
    if (!_this.options.assets) {
      return callback();
    }

    _mkdirp2.default.sync(_this.options.assets.path);

    var chunks = compilation.getStats().toJson().assetsByChunkName;

    Object.keys(chunks).forEach(function (chunkName) {
      if (chunkName !== _this.chunkName) {
        for (var value in _this.assetsMap) {
          // don't force so we keep our versions of vendor and stuff if they're here already
          _this.addToAssetsMap(value, chunkName, 'js', '' + compilation.outputOptions.publicPath + chunks[chunkName], false);
        }
      }
    });

    Object.keys(compilation.assets).forEach(function (assetName) {
      var ext = _path2.default.extname(assetName);
      if (ext !== '.js') {
        // horrible quick and dirty fix for .css and .rtl.css
        if (ext === '.css') {
          var secondExt = _path2.default.extname(assetName.replace(ext, ''));
          if (secondExt === '.rtl') {
            for (var value in _this.assetsMap) {
              _this.addToAssetsMap(value, _this.chunkName, 'rtl.css', '' + compilation.outputOptions.publicPath + assetName);
            }
          } else {
            for (var _value in _this.assetsMap) {
              _this.addToAssetsMap(_value, _this.chunkName, ext.replace('.', ''), '' + compilation.outputOptions.publicPath + assetName);
            }
          }
        } else {
          for (var _value2 in _this.assetsMap) {
            _this.addToAssetsMap(_value2, _this.chunkName, ext.replace('.', ''), '' + compilation.outputOptions.publicPath + assetName);
          }
        }
      }
    });

    if (/\[value\]/.test(_this.options.assets.filename)) {
      for (var value in _this.assetsMap) {
        var filePath = _path2.default.join(_this.options.assets.path, _this.options.assets.filename.replace('[value]', value));
        var content = _this.options.assets.prettyPrint ? JSON.stringify(_this.assetsMap[value], null, 2) : JSON.stringify(_this.assetsMap[value]);

        _fs2.default.writeFileSync(filePath, content, { flag: 'w' });
        _this.log('Asset file ' + filePath + ' written');
      }
    } else {
      var _filePath = _path2.default.join(_this.options.assets.path, _this.options.assets.filename);
      var _content = _this.options.assets.prettyPrint ? JSON.stringify(_this.assetsMap, null, 2) : JSON.stringify(_this.assetsMap);

      _fs2.default.writeFileSync(_filePath, _content, { flag: 'w' });
      _this.log('Asset file ' + _filePath + ' written');
    }

    callback();
  });
};

WebpackMultiOutput.prototype.getFilePath = function (string) {
  var match = string.match(this.filePathRe);

  return match ? match[1] : '';
};

WebpackMultiOutput.prototype.processRawSource = function (value, source, callback) {
  var _this2 = this;

  var _source = source.source();
  var replaces = [];
  var matches = _source.match(this.filePathReG);

  (0, _async.forEachOfLimit)(matches, 10, function (match, k, cb) {
    _this2.replaceContent(match, value, function (err, result) {
      replaces.push({ source: match, replace: result });
      cb();
    });
  }, function () {
    replaces.forEach(function (replace) {
      _source = _source.replace('"' + replace.source + '"', replace.replace);
    });

    _source = _source.replace(/__WEBPACK_MULTI_OUTPUT_VALUE__/g, value);

    callback(new _webpackSources.ConcatSource(_source));
  });
};

WebpackMultiOutput.prototype.processSourceWithSourceMap = function (value, source, callback, filename) {
  var _this3 = this;

  var result = void 0;

  var matches = source.source().match(this.filePathReG);
  var _source = new _FasterReplaceSource2.default(source, filename);
  var replaces = [];

  (0, _async.forEachOfLimit)(matches, 10, function (match, k, cb) {
    _this3.replaceContent(match, value, function (err, result) {
      replaces.push({ source: match, replace: result });
      cb();
    });
  }, function () {
    replaces.forEach(function (replace) {
      var snippetToFind = '"' + replace.source + '"';
      replaceSnippetOnSource(_source, snippetToFind, replace.replace);
    });

    var snippetToFind = '__WEBPACK_MULTI_OUTPUT_VALUE__';

    replaceSnippetOnSource(_source, snippetToFind, value);

    var _source$sourceAndMap = _source.sourceAndMap(),
        newSource = _source$sourceAndMap.source,
        newMap = _source$sourceAndMap.map;

    var sourceAndMap = new _webpackSources.SourceMapSource(newSource, filename, newMap);

    result = new _webpackSources.ConcatSource(sourceAndMap);

    callback(result);
  });
};

WebpackMultiOutput.prototype.processSource = function (value, source, callback, filename) {
  if ((0, _ModuleFilenameHelpers.matchObject)(this.options.sourceMaps, filename)) {
    return this.processSourceWithSourceMap(value, source, callback, filename);
  } else {
    return this.processRawSource(value, source, callback);
  }
};

WebpackMultiOutput.prototype.replaceContent = function (source, value, callback) {
  var resourcePath = this.options.replaceResourcePath(this.getFilePath(source));
  var newResourcePath = this.options.replaceResourcePath(resourcePath, value);

  var content = '{}';
  try {
    this.log('Replacing content for ' + newResourcePath, 'ultra');
    content = require(newResourcePath);
  } catch (_) {
    try {
      content = require(resourcePath);
    } catch (e) {
      callback(e);
      return;
    }
  }

  callback(null, JSON.stringify(content));
};

WebpackMultiOutput.prototype.replaceChunkMap = function (source) {
  this.log('Replacing chunk map ' + JSON.stringify(this.chunksMap), 'ultra');
  return new _webpackSources.ConcatSource(source.source().replace(/\{__WEBPACK_MULTI_OUTPUT_CHUNK_MAP__:2\}/, JSON.stringify(this.chunksMap)));
};

WebpackMultiOutput.prototype.addToAssetsMap = function (value, name, ext, filePath) {
  var force = arguments.length > 4 && arguments[4] !== undefined ? arguments[4] : true;

  var newAsset = _defineProperty({}, value, _defineProperty({}, name, _defineProperty({}, ext, filePath)));

  if (force) {
    this.assetsMap = (0, _lodash4.default)(this.assetsMap, newAsset);
  } else {
    this.assetsMap = (0, _lodash4.default)(newAsset, this.assetsMap);
  }
};

WebpackMultiOutput.prototype.log = function (message) {
  var level = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 'debug';

  if (level === 'ultra') {
    return this.options.ultraDebug && console.log('[WebpackMultiOutput] ' + +new Date() + ' - ' + message);
  }

  this.options.debug && console.log('[WebpackMultiOutput] ' + message);
};
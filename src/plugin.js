/* @flow */

import fs from 'fs'
import path from 'path'
import {createHash} from 'crypto'
import mkdirp from 'mkdirp'
import clone from 'lodash.clone'
import merge from 'lodash.merge'
import {ConcatSource, RawSource, SourceMapSource} from 'webpack-sources'
import {forEachOfLimit, setImmediate as asyncSetImmediate} from 'async'
import { matchObject } from 'webpack/lib/ModuleFilenameHelpers';

import FasterReplaceSource from './FasterReplaceSource';

const baseAssets = {
  filename: 'assets.json',
  path: '.',
  prettyPrint: false,
}

export default function WebpackMultiOutput(options: Object = {}): void {
  this.options = merge({
    values: [],
    debug: false,
    ultraDebug: false,
    uglify: false,
    replaceResourcePath: function(resourcePath, value) {
      const ext = path.extname(resourcePath)
      const basename = path.basename(resourcePath, ext)
      return resourcePath.replace(`${basename}${ext}`, `${value}${ext}`)
    },
    sourceMaps: {},
  }, options)

  this.options.assets = typeof options.assets === 'object' ? merge(baseAssets, options.assets) : false

  this.addedAssets = []
  this.assetsMap = {}
  this.chunksMap = {}
  this.chunkName = ''
  this.chunkHash = ''
  this.filePathRe = /WebpackMultiOutput-(.*?)-WebpackMultiOutput/
  this.filePathReG = /WebpackMultiOutput-(.*?)-WebpackMultiOutput/g
  this.jsonpRe = /__WEBPACK_MULTI_OUTPUT_CHUNK_MAP__/
}

function findAllOccurrences(str: string, find: string) {
    const regex = new RegExp(find, 'g');
    const indices = [];
    let result;
    while ((result = regex.exec(str))) {
      indices.push(result.index);
    }

    return indices;
}
function replaceSnippetOnSource(source: object, match: string, replacement: string): Boolean {
  const original = source._source.source();
  const indexes = findAllOccurrences(original, match);
  // we substract 1 out of the length given that the string pos starts in 0 :P
  const offset = match.length - 1;

  if (indexes.length) {
    indexes.forEach((from) => {
      source.replace(from, from + offset , '');
      source.insert(from, replacement);
    });
    return true;
  }
  return false;
}

WebpackMultiOutput.prototype.apply = function(compiler: Object): void {
  compiler.plugin('compilation', (compilation: Object): void => {
    compilation.__webpackMultiOutput = true

    if (path.extname(compilation.outputOptions.filename) === '.js' && !this.needsHash) {
      this.needsHash = /\[hash\]/.test(compilation.outputOptions.filename)
    }

    if (!this.options.values.length) {
      compilation.errors.push(new Error(`[webpack-multi-output] Error: option "values" must be an array of length >= 1`))
    }

    compilation.plugin('optimize-chunk-assets', (chunks: Array<Object>, callback: Function): void => {
      forEachOfLimit(chunks, 5, (chunk: Object, y: number, chunkCallback: Function) => {
        forEachOfLimit(chunk.files, 5, (file: string, k: number, fileCallback: Function) => {
          if (path.extname(file) !== '.js') {
            return asyncSetImmediate(fileCallback)
          }

          const source: Object = compilation.assets[file]

          // ignore files with no code the replace
          // and no jsonp script
          if (!this.filePathReG.test(source.source()) && !this.jsonpRe.test(source.source())) {
            this.log(`Ignoring asset ${file}, no replacement to process`, 'ultra')
            return asyncSetImmediate(fileCallback)
          }

          forEachOfLimit(this.options.values, 5, (value: string, l: number, languageCallback: Function) => {
            const basename = path.basename(file, '.js')
            const filename = `${value}.${basename}.js`
            const sourceMapFilename = `${filename}.map`;

            this.processSource(value, clone(source), (result) => {
              this.log(`Add asset ${filename}`)
              compilation.assets[filename] = result

              this.chunksMap[chunk.id] = true
              this.addedAssets.push({value, filename, name: chunk.name})

              if (matchObject(this.options.sourceMaps, filename)) {
                const sourceMap = result.map();

                if (sourceMap.mappings) {
                  chunk.files.push(filename);
                  compilation.assets[sourceMapFilename] = new RawSource(JSON.stringify(sourceMap));

                }
              }

              if (chunk.name) {
                if (this.needsHash) {
                  this.chunkHash = compilation.getStats().hash
                }
                this.chunkName = chunk.name
                this.addToAssetsMap(value, chunk.name, 'js', `${compilation.outputOptions.publicPath}${filename}`)
              }

              return asyncSetImmediate(languageCallback);
            }, filename)
          }, fileCallback);
        }, chunkCallback)
      }, callback)
    })

    compilation.plugin('optimize-assets', (assets: Object, callback: Function): void => {
      const length = this.chunkHash.length

      forEachOfLimit(this.addedAssets, 5, ({value, filename, name}, index, assetCallback) => {
        const source = this.replaceChunkMap(compilation.assets[filename])

        if (!this.needsHash) {
          compilation.assets[filename] = source
          return asyncSetImmediate(assetCallback)
        }

        const fileHash = createHash('md5').update(source.source()).digest('hex').substr(0, length)
        const newFilename = filename.replace(this.chunkHash, fileHash)

        this.log(`Update hash in filename for ${filename} -> ${newFilename}`, 'ultra')

        if (filename !== newFilename) {
          compilation.assets[newFilename] = source
          delete compilation.assets[filename]
          this.addToAssetsMap(value, name, 'js', `${compilation.outputOptions.publicPath}${newFilename}`)
        }

        assetCallback()
      }, callback)
    })

    compilation.mainTemplate.hooks.render.tap(
      // NOTE: the `stage: Infinity` setting is necessary to make this hook run after the code that generates
      // the webpack runtime, as otherwise we don't have the right content to replace...
      {
				name: "JsonpMainTemplatePlugin chunkId replacement",
				stage: Infinity
			}, rawSource => {
      const sourceString = rawSource.source()
      if (!sourceString.includes('jsonpScriptSrc')) {
        return rawSource;
      } else {
        // HACK: Find the line containing `jsonpScriptSrc`, which looks like 
        // /******/ 	function jsonpScriptSrc(chunkId) {
        // /******/ 		return __webpack_require__.p + "" + ({$CHUNK_ID_TO_NAME_MAP}[chunkId]||chunkId) + ".js"
        // /******/ 	}
        // and replace `chunkId` with `webpackMultiOutputGetChunkId(chunkId)`, which attaches the locale 
        // [specified in `__WEBPACK_MULTI_OUTPUT_CHUNK_MAP__`] if necessary.
        const sourceArray = sourceString.split('\n')

        const chunkIdModifier = `var webpackMultiOutputGetChunkId = function(chunkId) {
          var map = {__WEBPACK_MULTI_OUTPUT_CHUNK_MAP__:2};
          return map[chunkId] ? '__WEBPACK_MULTI_OUTPUT_VALUE__.' + chunkId : chunkId;
        };
        `
        const jsonpScriptSrcFunctionIndex = sourceArray.findIndex(a => a.includes('jsonpScriptSrc'))

        sourceArray[jsonpScriptSrcFunctionIndex + 1] = sourceArray[jsonpScriptSrcFunctionIndex + 1].replace('chunkId', 'webpackMultiOutputGetChunkId(chunkId)')
        sourceArray.splice(jsonpScriptSrcFunctionIndex + 1, 0, chunkIdModifier)

        return sourceArray.join('\n');
      }
    })
  })

  compiler.plugin('after-emit', (compilation: Object, callback: Function): void => {
    if (!this.options.assets) {
      return callback()
    }

    mkdirp.sync(this.options.assets.path)

    const chunks = compilation.getStats().toJson().assetsByChunkName

    Object.keys(chunks).forEach(chunkName => {
      if (chunkName !== this.chunkName) {
        for (let value in this.assetsMap) {
          // don't force so we keep our versions of vendor and stuff if they're here already
          this.addToAssetsMap(value, chunkName, 'js', `${compilation.outputOptions.publicPath}${chunks[chunkName]}`, false)
        }
      }
    })

    Object.keys(compilation.assets).forEach((assetName: string): void => {
      const ext = path.extname(assetName)
      if (ext !== '.js') {
        // horrible quick and dirty fix for .css and .rtl.css
        if (ext === '.css') {
          const secondExt = path.extname(assetName.replace(ext, ''))
          if (secondExt === '.rtl') {
            for (let value in this.assetsMap) {
              this.addToAssetsMap(value, this.chunkName, 'rtl.css', `${compilation.outputOptions.publicPath}${assetName}`)
            }
          }
          else {
            for (let value in this.assetsMap) {
              this.addToAssetsMap(value, this.chunkName, ext.replace('.', ''), `${compilation.outputOptions.publicPath}${assetName}`)
            }
          }
        }
        else {
          for (let value in this.assetsMap) {
            this.addToAssetsMap(value, this.chunkName, ext.replace('.', ''), `${compilation.outputOptions.publicPath}${assetName}`)
          }
        }
      }
    })

    if (/\[value\]/.test(this.options.assets.filename)) {
      for (let value in this.assetsMap) {
        const filePath = path.join(this.options.assets.path, this.options.assets.filename.replace('[value]', value))
        const content = this.options.assets.prettyPrint ? JSON.stringify(this.assetsMap[value], null, 2) : JSON.stringify(this.assetsMap[value])

        fs.writeFileSync(filePath, content, {flag: 'w'})
        this.log(`Asset file ${filePath} written`)
      }
    }
    else {
      const filePath = path.join(this.options.assets.path, this.options.assets.filename)
      const content = this.options.assets.prettyPrint ? JSON.stringify(this.assetsMap, null, 2) : JSON.stringify(this.assetsMap)

      fs.writeFileSync(filePath, content, {flag: 'w'})
      this.log(`Asset file ${filePath} written`)
    }

    callback()
  })
}

WebpackMultiOutput.prototype.getFilePath = function(string: string): string {
  const match = string.match(this.filePathRe)

  return match ? match[1] : ''
}

WebpackMultiOutput.prototype.processRawSource = function(value: string, source: Object, callback: Function): void {
  let _source = source.source()
  const replaces = []
  const matches = _source.match(this.filePathReG)

  forEachOfLimit(matches, 10, (match: string, k: number, cb: Function): void => {
    this.replaceContent(match, value, (err, result) => {
      replaces.push({source: match, replace: result})
      cb()
    })
  }, () => {
    replaces.forEach(replace => {
      _source = _source.replace(`"${replace.source}"`, replace.replace)
    })

    _source = _source.replace(/__WEBPACK_MULTI_OUTPUT_VALUE__/g, value)

    callback(new ConcatSource(_source))
  })
}

WebpackMultiOutput.prototype.processSourceWithSourceMap = function(value: string, source: Object, callback: Function, filename: string): void {
  let result;

  const matches = source.source().match(this.filePathReG);
  const _source = new FasterReplaceSource(source, filename);
  const replaces = [];

  forEachOfLimit(matches, 10, (match: string, k: number, cb: Function): void => {
    this.replaceContent(match, value, (err, result) => {
      replaces.push({source: match, replace: result})
      cb()
    })
  }, () => {
    replaces.forEach(replace => {
      const snippetToFind = `"${replace.source}"`;
      replaceSnippetOnSource(_source, snippetToFind, replace.replace);
    });

    const snippetToFind = '__WEBPACK_MULTI_OUTPUT_VALUE__';

    replaceSnippetOnSource(_source, snippetToFind, value);

    const { source: newSource, map: newMap } = _source.sourceAndMap();

    const sourceAndMap = new SourceMapSource(
      newSource,
      filename,
      newMap
    );

    result = new ConcatSource(sourceAndMap);

    callback(result);
  })
}

WebpackMultiOutput.prototype.processSource = function(value: string, source: Object, callback: Function, filename: string): void {
  if (matchObject(this.options.sourceMaps, filename)) {
    return this.processSourceWithSourceMap(value, source, callback, filename);
  } else {
    return this.processRawSource(value, source, callback);
  }
}

WebpackMultiOutput.prototype.replaceContent = function(source: string, value: string, callback: Function): void {
  const resourcePath = this.options.replaceResourcePath(this.getFilePath(source));
  let newResourcePath = this.options.replaceResourcePath(resourcePath, value);

  let content = '{}';
  try {
    this.log(`Replacing content for ${newResourcePath}`, 'ultra')
    content = require(newResourcePath);
  } catch (_) {
    try {
      content = require(resourcePath);
    } catch (e) {
      callback(e);
      return;
    }
  }

  callback(null, JSON.stringify(content))
}

WebpackMultiOutput.prototype.replaceChunkMap = function(source: Object): string {
  this.log(`Replacing chunk map ${JSON.stringify(this.chunksMap)}`, 'ultra')
  return new ConcatSource(source.source().replace(/\{__WEBPACK_MULTI_OUTPUT_CHUNK_MAP__:2\}/, JSON.stringify(this.chunksMap)))
}

WebpackMultiOutput.prototype.addToAssetsMap = function(value: string, name: string, ext: string, filePath: string, force: boolean = true): void {
  const newAsset = {
    [value]: {
      [name]: {
        [ext]: filePath
      }
    }
  }

  if (force) {
    this.assetsMap = merge(this.assetsMap, newAsset)
  }
  else {
    this.assetsMap = merge(newAsset, this.assetsMap)
  }
}

WebpackMultiOutput.prototype.log = function(message: string, level: string = 'debug'): void {
  if (level === 'ultra') {
    return this.options.ultraDebug && console.log(`[WebpackMultiOutput] ${+new Date} - ${message}`)
  }

  this.options.debug && console.log(`[WebpackMultiOutput] ${message}`)
}

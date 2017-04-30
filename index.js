const fs = require('fs')
const https = require('https')
const http = require('http')
const path = require('path')
const spawn = require('child_process').spawn
const url = require('url')
const zlib = require('zlib')

// Print out CLI usage.
const usage = () => {
  console.error(
`Usage: prebuilt-bindings [command...]

Commands:
  build     Builds bindings locally.
  clean     Removes installed bindings.
  config    Prints out the resolved config. Can be useful to understand what
            prebuilt-bindings sees.
  install   Installs prebuilt bindings or builds them if none can be found.
            Default command if none is given.
  pack      Packs configured bindings into properly named individual archives
            for easy deployment.
`
  )
}

// The main CLI.
module.exports = (options) => {
  return new Promise((resolve, reject) => {
    const args = process.argv.slice(2)

    // Don't run yet, map to a runner instead. This allows us to bail on
    // unsupported options prior to anything actually running.
    const cmds = !args.length ? [() => install(options)] : args.map(cmd => {
      switch (cmd) {
        case 'build':
          return () => build(options)
        case 'clean':
          return () => clean(options)
        case 'config':
          return () => expandConfig(options).then(config => {
            console.log(JSON.stringify(config, null, 2))
          })
        case 'install':
          return () => install(options)
        case 'pack':
          return () => pack(options)
        case '-h':
        case '--help':
        case 'help':
          return () => usage()
        default:
          throw new Error(`Unknown command '${cmd}'`)
      }
    })

    const next = () => {
      const cmd = cmds.shift()
      if (cmd) {
        return Promise.resolve(cmd()).then(next)
      }
      return Promise.resolve()
    }

    // Ok, run now.
    return resolve(next())
  })
  .catch(err => {
    usage()
    console.error(`${err}`)
    process.exit(1)
  })
}

const log = module.exports.log = (message) => {
  console.error(`[prebuilt-bindings] => ${message}`)
}

// Builds all bindings locally.
const build = module.exports.build = () => {
  log('Building from source...')
  return new Promise((resolve, reject) => {
    const opts = {
      stdio: 'inherit'
    }

    // NPM makes sure that node-gyp is in PATH. Rely on that happening,
    // adding cross-platform path guessing code added nearly 100 lines. It
    // was tried.
    const gyp = /^win/.test(process.platform)
      ? spawn('cmd.exe', ['/c', 'node-gyp', 'rebuild'], opts)
      : spawn('node-gyp', ['rebuild'], opts)

    gyp.on('error', reject)
    gyp.on('exit', (code, signal) => {
      if (signal) {
        return reject(new Error(`node-gyp was killed with signal ${signal}`))
      }

      if (code !== 0) {
        return reject(new Error(`node-gyp failed with status ${code}`))
      }

      resolve()
    })
  })
}

// Cleans up currently installed bindings.
const clean = module.exports.clean = (options) => {
  return expandConfig(options).then(config => {
    return Promise.all(config.bindings.map(binding => {
      log(`Removing '${binding.local}'...`)
      return new Promise((resolve, reject) => {
        fs.unlink(binding.local, err => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
      .catch(err => {
        if (err.code !== 'ENOENT') {
          throw err
        }
      })
    }))
  })
  .then(() => log(`Cleanup finished!`))
  .catch(err => {
    log(`Unable to clean up bindings: ${err}`)
    return build()
  })
}

// Installs prebuilt bindings or falls back to building them.
const install = module.exports.install = (options) => {
  return expandConfig(options).then(config => {
    return Promise.all(config.bindings.map(binding => {
      const local = binding.local
      return test(local).catch(() => {
        const remotes = [].concat(binding.remote)
        const next = () => {
          const remote = remotes.shift()
          if (!remote) {
            return Promise.reject(new Error('No compatible bindings found'))
          }
          return createWriter(local)
            .then(writer => download(remote, writer))
            .then(() => test(local))
            .catch(next)
        }
        return next()
      })
    }))
  })
  .then(() => log('Prebuilt bindings installed!'))
  .catch(err => {
    log(`Unable to install prebuilt bindings: ${err}`)
    return build()
  })
}

// Packs built bindings for deployment while checking for compatibility.
const pack = module.exports.pack = (options) => {
  return expandConfig(options).then(config => {
    return Promise.all(config.bindings.map(binding => {
      const packfile = `${defaultBindingFilename(binding.name)}.gz`
      const packer = zlib.createGzip({
        level: 9
      })

      return test(binding.local)
        .then(() => {
          return new Promise((resolve, reject) => {
            // Verify that the file can be read before setting up the writer.
            const reader = fs.createReadStream(binding.local)
            reader.on('open', () => resolve(reader))
            reader.on('error', reject)
          })
        })
        .then(reader => {
          return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(packfile)
            reader.on('error', reject)
              .pipe(packer)
              .on('error', reject)
              .pipe(writer)
              .on('error', reject)
              .on('finish', resolve)
          })
        })
        .then(() => console.log(`${packfile}`))
    }))
  })
  .catch(err => {
    log(`Unable to pack prebuilt bindings: ${err}`)
  })
}

// Request the given URL without making any decisions about the response.
// All logic is left to the handler.
const request = module.exports.request = (options, handler) => {
  return new Promise((resolve, reject) => {
    const proto = ({ 'http:': http })[options.protocol] || https
    const req = proto.get(options, (res) => {
      Promise.resolve(handler(req, res)).then(resolve, reject)
    })
    req.on('error', reject)
  })
}

// Downloads the given URL and pipes a qualifying response to the writer.
// Redirects are followed. To keep things simple, assumes that redirect
// loops don't happen.
const download = module.exports.download = (src, writer) => {
  log(`Downloading '${src}'...`)

  const options = Object.assign({}, url.parse(src), {
    headers: {
      'Accept-Encoding': 'gzip, deflate'
    }
  })

  return request(options, (req, res) => new Promise((resolve, reject) => {
    const statusCode = res.statusCode

    switch (statusCode) {
      case 200:
        break
      case 301:
      case 302:
      case 303:
      case 307:
      case 308: {
        const location = res.headers['location']
        res.resume()
        log(`Following ${statusCode} redirect to '${location}'`)
        return resolve(download(location, writer))
      }
      default: {
        req.abort()
        const statusMessage = res.statusMessage
        log(`Server responded with '${statusCode} ${statusMessage}'`)
        throw new Error(`HTTP ${statusCode}`)
      }
    }

    return resolve(new Promise((resolve, reject) => {
      const decode = (stream) => {
        const contentEncoding = res.headers['content-encoding']
        switch (contentEncoding) {
          case 'gzip':
            return stream.pipe(zlib.createGunzip()).on('error', reject)
          case 'deflate':
            return stream.pipe(zlib.createInflate()).on('error', reject)
          default:
            return stream
        }
      }

      const unpack = (stream) => {
        if (options.pathname.endsWith('.gz')) {
          return stream.pipe(zlib.createGunzip()).on('error', reject)
        }

        return stream
      }

      unpack(decode(res.on('error', reject)))
        .on('error', reject)
        .pipe(writer)
        .on('error', reject)
        .on('finish', resolve)
    }))
  }))
}

// Tests whether the given file functions as a node module.
const test = module.exports.test = (file) => {
  log(`Testing '${file}'...`)
  return new Promise((resolve, reject) => {
    try {
      require(file)
      return resolve()
    } catch (err) {
      log('Binding not found or incompatible')
      throw err
    } finally {
      delete require.cache[file]
    }
  })
}

// Attempts to figure out the repository URL from the given package
// configuration.
const repositoryUrlFromPackage = module.exports.repositoryUrlFromPackage = (pkg) => {
  if (!('repository' in pkg)) {
    throw new Error('Repository not set in package.json')
  }

  const expandRepositoryUrlShortcut = (shortcut) => {
    const urlObject = url.parse(shortcut)
    if (urlObject.protocol) {
      switch (urlObject.protocol) {
        case 'http:':
        case 'https:':
          return shortcut
        default:
          throw new Error(`Unsupported repository shortcut '${shortcut}'`)
      }
    }
    return `https://github.com/${shortcut}`
  }

  const urlObject = typeof pkg.repository === 'string'
    ? expandRepositoryUrlShortcut(pkg.repository)
    : url.parse(pkg.repository.url)

  switch (urlObject.protocol) {
    case 'http:':
    case 'https:':
      return urlObject
    case 'git+http:':
      urlObject.protocol = 'http:'
      return urlObject
    case 'git+https:':
      urlObject.protocol = 'https:'
      return urlObject
    default:
      throw new Error(`Unsupported repository URL '${urlObject.href}'`)
  }
}

// Returns the default deployed binding name for the given name.
const defaultBindingFilename = module.exports.defaultBindingFilename = (name) => {
  return `${[
    name,
    process.versions.modules,
    process.platform,
    process.arch
  ].join('-')}.node`
}

// Returns a list of likely binding URLs for the given name based on the
// package configuration.
const defaultBindingUrlsFromPackage = module.exports.defaultBindingUrlsFromPackage = (name, pkg) => {
  if (!('repository' in pkg)) {
    throw new Error('Repository not set in package.json')
  }

  const noslash = (str) => str.replace(/\/$/, '')
  const nogit = (str) => str.replace(/\.git$/, '')

  const downloadUrlObject = repositoryUrlFromPackage(pkg)
  downloadUrlObject.pathname = [
    nogit(noslash(downloadUrlObject.pathname)),
    'releases',
    'tag',
    `v${pkg.version}`,
    defaultBindingFilename(name)
  ].join('/')

  return [
    url.format(Object.assign({}, downloadUrlObject, {
      pathname: `${downloadUrlObject.pathname}.gz`
    })),
    url.format(downloadUrlObject)
  ]
}

// Creates any missing directories up to and including the given directory.
const mkdirp = module.exports.mkdirp = (dir) => {
  const mkdir = (dir) => new Promise((resolve, reject) => {
    fs.mkdir(dir, err => {
      if (err) {
        reject(err)
      } else {
        resolve(dir)
      }
    })
  })

  return mkdir(dir).catch(err => {
    switch (err.code) {
      case 'EEXIST':
        return dir
      case 'ENOENT':
        return mkdirp(path.dirname(dir)).then(() => mkdir(dir))
      default:
        throw err
    }
  })
}

// Creates a writer for the given file, creating any missing directories.
const createWriter = module.exports.createWriter = (file) => {
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(file)
    writer.on('open', () => resolve(writer))
    writer.on('error', reject)
  })
  .catch(err => {
    if (err.code !== 'ENOENT') {
      throw err
    }

    return mkdirp(path.dirname(file)).then(() => createWriter(file))
  })
}

// Expands user-provided options into a usable configuration.
const expandConfig = module.exports.expandConfig = (options) => {
  return new Promise((resolve, reject) => {
    if (!options || !options.context) {
      throw new Error(`Missing 'context' option`)
    }

    const context = options.context || path.resolve(__dirname, '../..')
    const pkg = require(path.resolve(context, 'package'))

    const bindings = options.bindings.map(binding => {
      const name = binding.name
      const remote = binding.remote
        ? [].concat(binding.remote)
        : defaultBindingUrlsFromPackage(name, pkg)
      const local = path.resolve(
        context,
        binding.local || `build/Release/${name}.node`
      )

      return Object.assign({}, binding, {
        name,
        remote,
        local
      })
    })

    resolve(Object.assign({}, options, {
      context,
      bindings
    }))
  })
}

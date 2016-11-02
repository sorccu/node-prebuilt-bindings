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
`Usage: prebuilt-bindings [<command>...]

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
const main = module.exports = (config) => {
  return expandConfig(config).then(config => {
    const args = process.argv.slice(2)

    // Don't run yet, map to a runner instead. This allows us to bail on
    // unsupported options prior to anything actually running.
    const cmds = !args.length ? [() => install(config)] : args.map(cmd => {
      switch (cmd) {
        case 'build':
          return () => build()
        case 'clean':
          return () => clean(config)
        case 'config':
          return () => console.log(JSON.stringify(config, null, 2))
        case 'install':
          return () => install(config)
        case 'pack':
          return () => pack(config)
        case '-h':
        case '--help':
        case 'help':
          return () => usage()
        default: {
          throw new Error(`Unknown command '${cmd}'`)
        }
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
    return next()
  })
  .catch(err => {
    usage()
    console.error(`${err}`, err)
    process.exit(1)
  })
}

const log = module.exports.log = (message) => {
  console.error(`[prebuilt-bindings] => ${message}`)
}

const clean = module.exports.clean = (config) => {
  return Promise.all(config.bindings.map(binding => {
    return new Promise((resolve, reject) => {
      fs.unlink(binding.local, err => {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
    .then(() => log(`Cleaned up ${binding.local}`))
    .catch(err => {
      if (err.code !== 'ENOENT') {
        throw err
      }
    })
  }))
}

const install = module.exports.install = (config) => {
  return Promise.all(config.bindings.map(binding => {
    return test(binding.local).catch(() => {
      return createWriter(binding.local)
        .then(writer => {
          // @TODO Really support more than one location.
          return download(binding.remote.shift(), writer)
        })
        .then(() => test(binding.local).catch(err => {
          log(`Prebuilt binding is incompatible`)
          throw err
        }))
    })
  }))
  .then(() => log('Prebuilt bindings installed!'))
  .catch(err => {
    log(`Unable to install prebuilt bindings: ${err}`)
    return build()
  })
}

const pack = module.exports.pack = (config) => {
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

// Download the given URL and pipe a qualifying response to the writer.
// Redirects are followed. To keep things simple, assume no redirect loops.
const download = module.exports.download = (src, writer) => {
  log(`Downloading '${src}'...`)

  const options = Object.assign({}, url.parse(src), {
    headers: {
      'Accept-Encoding': 'gzip, deflate'
    }
  })

  return request(options, (req, res) => {
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
        log(`Following ${statusCode} redirect to ${location}`)
        return download(location, writer)
      }
      default: {
        req.abort()
        log(`Server responded with ${statusCode}`)
        throw new Error(`Request to '${src}' returned HTTP ${statusCode}`)
      }
    }

    const contentType = res.headers['content-type']

    return new Promise((resolve, reject) => {
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

        if (options.pathname.endsWith('.zip')) {
          return stream.pipe(zlib.createUnzip()).on('error', reject)
        }

        return stream
      }

      unpack(decode(res.on('error', reject)))
        .on('error', reject)
        .pipe(writer)
        .on('error', reject)
        .on('finish', resolve)
    })
  })
}

// Build all bindings. By this time it's clear that we can't find or access
// at least one prebuilt binding, causing a full rebuild.
const build = module.exports.build = () => {
  log('Building from source...')
  return new Promise((resolve, reject) => {
    const guessGyp = () => {
      if (process.env.npm_config_node_gyp) {
        return process.env.npm_config_node_gyp
      }

      return ({ 'win32': 'node-gyp.cmd' })[process.platform] || 'node-gyp'
    }

    // NPM makes sure that node-gyp is in PATH. Rely on that happening,
    // adding cross-platform path guessing code would easily add 50 mostly
    // useless lines.
    const gyp = spawn(guessGyp(), ['rebuild'], {
      stdio: 'inherit',
    })

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

// Test whether the given file functions as a node module.
const test = module.exports.test = (file) => {
  log(`Testing '${file}'...`)
  return new Promise((resolve, reject) => {
    try {
      require(file)
      return resolve()
    } catch (err) {
      log('Binding not found or incompatible.')
      throw err
    } finally {
      delete require.cache[file]
    }
  })
}

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
    default:
      throw new Error(`Unsupported repository URL '${urlObject.href}'`)
  }
}

const defaultBindingFilename = module.exports.defaultBindingFilename = (name) => {
  return `${[
    name,
    process.versions.modules,
    process.platform,
    process.arch
  ].join('-')}.node`
}

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
    'download',
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

const mkdirp = module.exports.mkdirp = (dir) => {
  const mkdir = (dir) => new Promise((resolve, reject) => {
    log(`mkdir ${dir}`)
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

const expandConfig = module.exports.expandConfig = (options) => {
  return new Promise((resolve, reject) => {
    if (!options || !options.context) {
      throw new Error(`Missing 'context' option`)
    }

    const context = options.context || path.resolve(__dirname, '../..')
    const pkg = require(path.resolve(context, 'package'))
    const repoUrl = repositoryUrlFromPackage(pkg)

    const bindings = options.bindings.map(binding => {
      const name = binding.name
      const remote = binding.remote
        ? [].concat(binding.remote)
        : defaultBindingUrlsFromPackage(name, pkg)
      const local = path.resolve(
        context,
        binding.local || `build/Release/${name}.node`
      )

      return {
        name,
        remote,
        local
      }
    })

    resolve({
      context,
      bindings
    })
  })
}

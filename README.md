# node-prebuilt-bindings

[![npm](https://img.shields.io/npm/v/prebuilt-bindings.svg)](https://www.npmjs.com/package/prebuilt-bindings)

**node-prebuilt-bindings** is an alternative to [node-pre-gyp](https://github.com/mapbox/node-pre-gyp). It allows your users to automatically fetch prebuilt native modules from a location you provide (e.g. GitHub Releases), avoiding messy compilation issues.

## Benefits/philosophy

* Leave legacy cruft behind. Only support most recent Node in [*active* Long-term Support](https://github.com/nodejs/LTS#lts-schedule) (currently v4) and newer.
    - Take advantage of [ES2015 and later features](http://node.green/) (but don't require `--harmony` flag).
* Configuration is code with sensible defaults.
    - Defaults to using [GitHub Releases](https://help.github.com/articles/about-releases/).
    - Easily implement features such as only building on specific platforms.
* Allows you to run `node-gyp` directly if you wish.
* Supports multiple bindings per module.
* Super easy [nvm](https://github.com/creationix/nvm) integration.
    - Global installation not required!
* Minimal bloat-free implementation.
* Dependency free!

## Installation

Using [yarn](https://yarnpkg.com/):

```sh
yarn add prebuilt-bindings
```

Using [npm](https://www.npmjs.com/):

```sh
npm install --save prebuilt-bindings
```

## Usage

## License

See [LICENSE](LICENSE).

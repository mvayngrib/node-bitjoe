'use strict'

var crypto = require('crypto')
var assert = require('assert')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var once = require('once')
var debug = require('debug')('chain-seal')
var bitcoin = require('@tradle/bitcoinjs-lib')
var utils = require('@tradle/utils')
var Q = require('q')
var typeForce = require('typeforce')
var uniq = require('uniq')
var extend = require('extend')
var ShareRequest = require('./share')
var common = require('../common')
var debug = common.debug

function CreateRequest (options) {
  EventEmitter.call(this)

  typeForce({
    wallet: 'Object',
    keeper: 'Object',
    networkName: 'String',
    minConf: 'Number',
    prefix: 'String'
  }, options)

  this._options = options
  extend(this, options)

  utils.bindPrototypeFunctions(this)

  this.network = bitcoin.networks[this.networkName]
  this._recipients = []
}

inherits(CreateRequest, EventEmitter)

CreateRequest.prototype.data = function (data) {
  assert(data, 'Missing required parameter: data')

  this._data = data
  if (typeof data === 'string') {
    this._dataBuf = new Buffer(data)
  } else if (Buffer.isBuffer(data)) {
    this._dataBuf = data
  } else if (typeof data === 'object') {
    this._dataBuf = new Buffer(JSON.stringify(data))
  } else {
    throw new TypeError('Parameter "data" can be one of the following types: String, Buffer, POJO')
  }

  // TODO: take into account size of payload
  this._permissionCost = common.permissionCost(this.networkName)

  return this
}

CreateRequest.prototype.shareWith =
CreateRequest.prototype.recipients = function (pubKeys) {
  if (!Array.isArray(pubKeys)) pubKeys = [pubKeys]

  this._recipients = uniq(pubKeys)
  return this
}

/**
 * Put on chain immediately
 * @param  {Boolean} chain
 * @return {CreateRequest} this instance
 */
CreateRequest.prototype.chain = function (chain) {
  this._chain = chain
  return this
}

CreateRequest.prototype.setPublic = function (isPublic) {
  typeForce('Boolean', isPublic)
  this._public = isPublic
  this._cleartext = isPublic
  return this
}

CreateRequest.prototype.chain = function (chain) {
  this._chain = chain
  return this
}

CreateRequest.prototype.build = function () {
  var self = this

  if (this._value) {
    return Q.reject(new Error('already built or building'))
  }

  if (!this._public) {
    if (!this._recipients.length) {
      return Q.reject(new Error('no recipients'))
    }
  }

  var req = {}
  return (this._public ? Q() : this._encrypt())
    .then(function (ciphertext) {
      self._value = req.value = ciphertext || self._dataBuf
      debug('0. calculating message hash for ' + (self._public ? 'public' : 'private') + ' message')
      return Q.ninvoke(utils, 'getStorageKeyFor', self._value)
    })
    .then(function (key) {
      self._key = key
      req.key = key.toString('hex')

      if (!self._public) {
        return Q.all(
          self._recipients.map(self._buildShare)
        )
      }
    })
    .then(function (results) {
      if (results && results.length) {
        req.shares = results
      }

      req.execute = once(self.execute.bind(self, req))
      return req
    })
}

CreateRequest.prototype.execute = function (req) {
  var self = this

  if (!req) return this.build().then(this.execute)

  return this.keeper.put(req.key, req.value)
    .then(function () {
      if (!self._public) return self._share(req)
    })
    .then(function () {
      delete req.execute
      return req
    })
}

CreateRequest.prototype._generateSymmetricKey = function () {
  return Q.ninvoke(crypto, 'randomBytes', 32)
}

CreateRequest.prototype._encrypt = function () {
  var self = this
  return this._generateSymmetricKey()
    .then(function (bytes) {
      self._symmetricKey = bytes
      return Q.ninvoke(utils, 'encryptAsync', {
        data: self._dataBuf,
        key: self._symmetricKey
      })
    })
}

CreateRequest.prototype._share = function (req) {
  var tasks = req.shares.map(function (req) {
    return req.execute()
  })

  return Q.all(tasks)
    .then(function () {
      return req
    })
}

CreateRequest.prototype._buildShare = function (pubKey) {
  return new ShareRequest(this._options)
    .shareAccessTo(this._key, this._symmetricKey)
    .shareAccessWith(pubKey)
    .build()
}

module.exports = CreateRequest

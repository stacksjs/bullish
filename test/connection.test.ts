import type { RedisOptions } from 'ioredis'
import type {
  Job,
} from '../src/classes'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import IORedis from 'ioredis'
import { v4 } from 'uuid'
import {
  FlowProducer,
  Queue,
  QueueBase,
  RedisConnection,
  Worker,
} from '../src/classes'

import { removeAllQueueData } from '../src/utils'

// Mock sinon functionality we need
class MockSinon {
  static createStub() {
    const stub = function () {}
    stub.restore = () => {}
    stub.called = false
    stub.calledOnce = false
    stub.resolves = () => {
      stub.called = false
      stub.calledOnce = true
      return stub
    }
    return stub
  }
}

describe('RedisConnection', () => {
  describe('constructor', () => {
    it('initializes with default extraOptions when none provided', () => {
      const connection = new RedisConnection({})
      expect((connection as any).extraOptions).toEqual({
        shared: false,
        blocking: true,
        skipVersionCheck: false,
        skipWaitingForReady: false,
      })
    })

    it('merges provided extraOptions with defaults', () => {
      const options = {
        shared: true,
        blocking: false,
        skipVersionCheck: true,
        skipWaitingForReady: true,
      }
      const connection = new RedisConnection({}, options)
      expect((connection as any).extraOptions).toMatchObject(options)
    })
  })

  describe('blocking option', () => {
    it('sets maxRetriesPerRequest to null when blocking is true', () => {
      const connection = new RedisConnection({}, { blocking: true })
      expect((connection as any).opts.maxRetriesPerRequest).toBeNull()
    })

    it('preserves maxRetriesPerRequest when blocking is false', () => {
      const connection = new RedisConnection(
        { maxRetriesPerRequest: 10 },
        { blocking: false },
      )
      expect((connection as any).opts.maxRetriesPerRequest).toBe(10)
    })
  })

  describe('connect()', () => {
    let waitUntilReadyStub: any

    beforeEach(() => {
      waitUntilReadyStub = MockSinon.createStub()
      RedisConnection.waitUntilReady = waitUntilReadyStub
    })

    afterEach(() => {
      waitUntilReadyStub.restore()
    })

    it('skips waiting for ready when skipWaitingForReady is true', async () => {
      const connection = new RedisConnection({}, { skipWaitingForReady: true })
      const _client = await connection.client
      expect(waitUntilReadyStub.called).toBeFalsy()
    })

    it('awaits ready state when skipWaitingForReady is false', async () => {
      const connection = new RedisConnection(
        {},
        { skipWaitingForReady: false },
      )
      const _client = await connection.client
      expect(waitUntilReadyStub.calledOnce).toBeTruthy()
    })
  })

  describe('Queue', () => {
    it('propagates skipWaitingForReady to RedisConnection', () => {
      const queue = new Queue('test', {
        skipWaitingForReady: true,
        connection: {},
      })
      expect((<any>queue).connection.extraOptions.skipWaitingForReady).toBeTruthy()
    })

    it('uses non-blocking connection by default', () => {
      const queue = new Queue('test')
      expect((<any>queue).connection.extraOptions.blocking).toBeFalsy()
    })

    it('uses shared connection if provided Redis instance', () => {
      const connection = new IORedis()

      const queue = new Queue('test', {
        connection,
      })
      expect((<any>queue).connection.extraOptions.shared).toBeTruthy()

      connection.disconnect()
    })
  })

  describe('Worker', () => {
    it('initializes blockingConnection with blocking: true', async () => {
      const worker = new Worker('test', async () => {}, { connection: {} })
      expect((<any>worker).blockingConnection.extraOptions.blocking).toBeTruthy()
      await worker.close()
    })

    it('sets shared: false for blockingConnection', async () => {
      const connection = new IORedis({ maxRetriesPerRequest: null })

      const worker = new Worker('test', async () => {}, { connection })
      expect((<any>worker).blockingConnection.extraOptions.shared).toBeFalsy()

      await worker.close()
      connection.disconnect()
    })

    it('uses blocking connection by default', async () => {
      const connection = new IORedis({ maxRetriesPerRequest: null })

      const worker = new Worker('test', async () => {}, { connection })

      expect((<any>worker).connection.extraOptions.blocking).toBeFalsy()
      expect((<any>worker).blockingConnection.extraOptions.blocking).toBeTruthy()

      await worker.close()
      connection.disconnect()
    })
  })

  describe('FlowProducer', () => {
    it('uses non-blocking connection', async () => {
      const flowProducer = new FlowProducer()
      expect((<any>flowProducer).connection.extraOptions.blocking).toBeFalsy()
      await flowProducer.close()
    })

    it('shares connection if provided Redis instance', () => {
      const connection = new IORedis()

      const flowProducer = new FlowProducer({
        connection,
      })
      expect((<any>flowProducer).connection.extraOptions.shared).toBeTruthy()

      connection.disconnect()
    })
  })
})

describe('connection', () => {
  const redisHost = process.env.REDIS_HOST || 'localhost'
  const prefix = process.env.BULLMQ_TEST_PREFIX || 'bull'
  let queue: Queue
  let queueName: string

  let connection: IORedis
  beforeAll(async () => {
    connection = new IORedis(redisHost, { maxRetriesPerRequest: null })
  })

  beforeEach(async () => {
    queueName = `test-${v4()}`
    queue = new Queue(queueName, { connection, prefix })
  })

  afterEach(async () => {
    await queue.close()
    await removeAllQueueData(new IORedis(redisHost), queueName)
  })

  afterAll(async () => {
    await connection.quit()
  })

  describe('establish ioredis connection', () => {
    it('should connect with host:port', async () => {
      const queue = new Queue('valid-host-port', {
        connection: {
          host: 'localhost',
          port: 6379,
          retryStrategy: () => null,
        },
      })

      const client = await queue.waitUntilReady()
      expect(client.status).toBe('ready')

      await queue.close()
    })

    it('should fail with invalid host:port', async () => {
      const queue = new Queue('invalid-host-port', {
        connection: {
          host: 'localhost',
          port: 9000,
          retryStrategy: () => null,
        },
      })

      await expect(() => queue.waitUntilReady()).rejects.toThrow(
        'connect ECONNREFUSED 127.0.0.1:9000',
      )
    })

    it('should connect with connection URL', async () => {
      const queue = new Queue('valid-url', {
        connection: {
          url: 'redis://localhost:6379',
          // Make sure defaults are not being used
          host: '1.1.1.1',
          port: 2222,
          retryStrategy: () => null,
        },
      })

      const client = await queue.waitUntilReady()
      expect(client.status).toBe('ready')

      await queue.close()
    })

    it('should fail with invalid connection URL', async () => {
      const queue = new Queue('invalid-url', {
        connection: {
          url: 'redis://localhost:9001',
          // Make sure defaults are not being used
          host: '1.1.1.1',
          port: 2222,
          retryStrategy: () => null,
        },
      })

      await expect(() => queue.waitUntilReady()).rejects.toThrow(
        'connect ECONNREFUSED 127.0.0.1:9001',
      )
    })
  })

  describe('prefix', () => {
    it('should throw exception if using prefix with ioredis', async () => {
      const connection = new IORedis({
        host: redisHost,
        keyPrefix: 'bullmq',
      })

      expect(() => new QueueBase(queueName, { connection })).toThrow(
        'BullMQ: ioredis does not support ioredis prefixes, use the prefix option instead.',
      )
      await connection.disconnect()
    })

    it('should throw exception if using prefix with ioredis in cluster mode', async () => {
      const connection = new IORedis.Cluster(
        [{ host: '10.0.6.161', port: 7379 }],
        {
          keyPrefix: 'bullmq',
          natMap: {},
        },
      )

      expect(() => new QueueBase(queueName, { connection })).toThrow(
        'BullMQ: ioredis does not support ioredis prefixes, use the prefix option instead.',
      )
      await connection.disconnect()
    })
  })

  describe('blocking', () => {
    it('should override maxRetriesPerRequest: null as redis options', async () => {
      if (redisHost === 'localhost') {
        // We cannot currently test this behaviour for remote redis servers
        const queue = new QueueBase(queueName, {
          connection: { host: 'localhost' },
        })

        const options = (connection as any).options

        expect(options.maxRetriesPerRequest).toBe(null)

        await queue.close()
      }
    })
  })

  describe('non-blocking', () => {
    it('should not override any redis options', async () => {
      const connection2 = new IORedis(redisHost, { maxRetriesPerRequest: 20 })

      const queue = new Queue(queueName, {
        connection: connection2,
      })

      const options = <RedisOptions>(await queue.client).options

      expect(options.maxRetriesPerRequest).toBe(20)

      await queue.close()
      await connection2.quit()
    })
  })

  describe('when maxmemory-policy is different than noeviction in Redis', () => {
    it.skip('throws an error', async () => {
      const opts = {
        connection: {
          host: 'localhost',
        },
      }

      const queue = new QueueBase(queueName, opts)
      const client = await queue.client
      await client.config('SET', 'maxmemory-policy', 'volatile-lru')

      const queue2 = new QueueBase(`${queueName}2`, opts)

      await expect(() => queue2.client).rejects.toThrow(
        'Eviction policy is volatile-lru. It should be "noeviction"',
      )
      await client.config('SET', 'maxmemory-policy', 'noeviction')

      await queue.close()
      await queue2.close()
    })
  })

  describe('when instantiating with a clustered ioredis connection', () => {
    it('should not fail when using dsn strings', async () => {
      const connection = new IORedis.Cluster(['redis://10.0.6.161:7379'], {
        natMap: {},
      })
      const _queue = new Queue('myqueue', { connection })
      connection.disconnect()
    })
  })

  it('should close worker even if redis is down', async () => {
    const connection = new IORedis('badhost', { maxRetriesPerRequest: null })
    connection.on('error', () => {})

    const worker = new Worker('test', async () => {}, { connection, prefix })

    worker.on('error', (_err) => {})
    await worker.close()
  })

  it('should close underlying redis connection when closing fast', async () => {
    const queue = new Queue('CALLS_JOB_QUEUE_NAME', {
      connection: {
        host: 'localhost',
        port: 6379,
      },
    })

    // Need to access protected properties for this test
    const client = (queue as any).connection._client
    await queue.close()

    expect(client.status).toBe('end')
  })

  it('should recover from a connection loss', async () => {
    let processor

    const processing = new Promise<void>((resolve) => {
      processor = async (job: Job) => {
        expect(job.data.foo).toBe('bar')
        resolve()
      }
    })

    const worker = new Worker(queueName, processor, { connection, prefix })

    worker.on('error', (_err) => {
      // error event has to be observed or the exception will bubble up
    })

    queue.on('error', (_err: Error) => {
      // error event has to be observed or the exception will bubble up
    })

    const workerClient = await worker.client
    const queueClient = await queue.client;

    // Simulate disconnect
    (<any>queueClient).stream.end()
    queueClient.emit('error', new Error('ECONNRESET'));

    (<any>workerClient).stream.end()
    workerClient.emit('error', new Error('ECONNRESET'))

    // add something to the queue
    await queue.add('test', { foo: 'bar' }, { delay: 2000 })

    await processing
    await worker.close()
  })

  it('should handle jobs added before and after a redis disconnect', async () => {
    let count = 0
    let processor

    const processing = new Promise<void>((resolve, reject) => {
      processor = async (job: Job) => {
        try {
          if (count === 0) {
            expect(job.data.foo).toBe('bar')
          }
          else {
            resolve()
          }
          count++
        }
        catch (err) {
          reject(err)
        }
      }
    })

    const worker = new Worker(queueName, processor, { connection, prefix })

    worker.on('error', (_err) => {
      // error event has to be observed or the exception will bubble up
    })

    queue.on('error', (_err: Error) => {
      // error event has to be observed or the exception will bubble up
    })

    await worker.waitUntilReady()

    worker.on('completed', async () => {
      if (count === 1) {
        const workerClient = await worker.client
        const queueClient = await queue.client;

        (<any>queueClient).stream.end()
        queueClient.emit('error', new Error('ECONNRESET'));

        (<any>workerClient).stream.end()
        workerClient.emit('error', new Error('ECONNRESET'))

        await queue.add('test', { foo: 'bar' })
      }
    })

    await queue.waitUntilReady()
    await queue.add('test', { foo: 'bar' })

    await processing

    await worker.close()
  })

  /*
  it('should not close external connections', () => {
    const client = new redis();
    const subscriber = new redis();

    const opts = {
      createClient(type) {
        switch (type) {
          case 'client':
            return client;
          case 'subscriber':
            return subscriber;
          default:
            return new redis();
        }
      },
    };

    const testQueue = utils.buildQueue('external connections', opts);

    return testQueue
      .isReady()
      .then(() => {
        return testQueue.add({ foo: 'bar' });
      })
      .then(() => {
        expect(testQueue.client).toBe(client);
        expect(testQueue.eclient).toBe(subscriber);

        return testQueue.close();
      })
      .then(() => {
        expect(client.status).toBe('ready');
        expect(subscriber.status).toBe('ready');
        return Promise.all([client.quit(), subscriber.quit()]);
      });
  });
  */

  it('should fail if redis connection fails', async () => {
    const queueFail = new Queue('connection fail port', {
      connection: { port: 1234, host: '127.0.0.1', retryStrategy: () => null },
    })

    await expect(() => queueFail.waitUntilReady()).rejects.toThrow(
      'connect ECONNREFUSED 127.0.0.1:1234',
    )
  })

  it('should emit error if redis connection fails', async () => {
    const queueFail = new Queue('connection fail port', {
      connection: { port: 1234, host: '127.0.0.1', retryStrategy: () => null },
    })

    const waitingErrorEvent = new Promise<void>((resolve, reject) => {
      queueFail.on('error', (err: Error) => {
        try {
          expect(err.message).toBe('connect ECONNREFUSED 127.0.0.1:1234')
          resolve()
        }
        catch (err) {
          reject(err)
        }
      })
    })

    await waitingErrorEvent
  })

  it('should close if connection has failed', async () => {
    const queueFail = new Queue('connection fail port', {
      connection: { port: 1234, host: '127.0.0.1', retryStrategy: () => null },
    })

    queueFail.on('error', () => {})

    await expect(() => queueFail.waitUntilReady()).rejects.toThrow(
      'connect ECONNREFUSED 127.0.0.1:1234',
    )

    await expect(queueFail.close()).resolves.toBeUndefined()
  })

  it('should close if connection is failing', async () => {
    const queueFail = new Queue('connection fail port', {
      connection: {
        port: 1234,
        host: '127.0.0.1',
        retryStrategy: times => (times === 0 ? 10 : null),
      },
    })

    await expect(() => queueFail.waitUntilReady()).rejects.toThrow(
      'connect ECONNREFUSED 127.0.0.1:1234',
    )

    await expect(queueFail.close()).resolves.toBeUndefined()
  })
})

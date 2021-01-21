import { useState, useEffect } from 'react';
import { resolveLater } from './resolve-later';

export interface AsyncReadable<T> {
  get(): Promise<T>;
}

export interface AsyncWritable<T> {
  set(newValue: T): Promise<void>;
}
export type AsyncReadWrite<T> = AsyncReadable<T> & AsyncWritable<T>;

export type AsyncIterableWritable<T> = AsyncIterable<T> & AsyncWritable<T>;

export interface WithDefault<T> {
  default: T | Partial<T>;
}

export interface MapArguments<T> {
  <S>(
    callback: (newValue: T) => Promise<S> | AsyncGenerator<S>,
    options?: WithDefault<S>
  ): AtomReadOnly<S>;
}

export interface AtomBase<T> extends AsyncReadable<T>, Partial<WithDefault<T>> {
  subscribe(listener: (newValue: T) => void): void;
  map: MapArguments<T>;
  select<S>(callback: (ownValue: T) => S | Promise<S>): AtomReadOnly<S>;
  reflect<S>(
    atom: Atom<S>,
    callback: (atomValue: S, ownValue: T) => Promise<T>
  ): AtomReadOnly<T>;
}

export type AtomReadOnly<T> = AtomBase<T> & AsyncIterable<T>;
export type AtomReadWrite<T> = AtomBase<T> & AsyncIterableWritable<T>;
export type Atom<T> = AtomReadOnly<T> | AtomReadWrite<T>;

export interface SetAndGenerateFromKey<T, K> {
  (key: K): {
    generate: () => AsyncGenerator<T, void>;
    set: (newValue: T) => Promise<void>;
  };
}

function aggregate<
  TIterables extends { [K in keyof TArray]: AsyncIterable<TArray[K]> },
  TAggregator extends (promises: TPromises) => Promise<T>,
  TArray extends S[], // Need to change with variadic tuple?
  S = TIterables extends AsyncIterable<infer U>[] ? U : never,
  TPromises = { [K in keyof TArray]: Promise<TArray[K]> },
  T = TAggregator extends (promises: TPromises) => Promise<infer U> ? U : never
>(
  iterables: TIterables,
  aggregator: TAggregator
): () => AsyncGenerator<T, void> {
  return async function* () {
    interface OmitPromise extends Promise<{ isOmit: true }> {
      isOmitPromise: true;
    }
    const alwaysResolves = Promise.resolve({ isOmit: true });
    (alwaysResolves as OmitPromise).isOmitPromise = true;
    const omitPromise: OmitPromise = alwaysResolves as OmitPromise; // Marker
    const generators = iterables
      .map(
        iterable =>
          async function* () {
            for await (const value of iterable) {
              yield value;
            }
            return omitPromise;
          }
      )
      .map(generate => generate());
    let donePromises = [Promise.resolve(false)];
    while (!(await Promise.all(donePromises)).every(done => done)) {
      const iteratorResultPromises = generators.map(generator =>
        generator.next()
      );
      donePromises = iteratorResultPromises.map(result =>
        result.then(({ done }) => done || false)
      );
      const valuePromises = iteratorResultPromises
        .map(result => result.then(({ value }) => value))
        .filter(result => !(result as OmitPromise).isOmitPromise);
      if (valuePromises.length === 0) {
        // No more updates
        return;
      }
      const yy = await aggregator((valuePromises as unknown) as TPromises);
      yield yy;
    }
  };
}

const stores = new Map<any, SetAndGenerateFromKey<any, any>>();

type PromiseDictionary<
  P extends { [key: string]: Promise<unknown> },
  T = P extends {
    [key: string]: Promise<infer U>;
  }
    ? U
    : never
> = {
  [K in keyof P]: Promise<{ key: K; value: T }>;
};

function promiseDictionary<
  P extends { [key: string]: Promise<T> },
  T = P extends {
    [key: string]: Promise<infer U>;
  }
    ? U
    : never
>(promises: P): PromiseDictionary<P> {
  return Object.entries(promises).reduce(
    (result, [key, promise]) => ({
      ...result,
      ...({
        [key]: promise.then(value => ({ key, value })),
      } as PromiseDictionary<P>),
    }),
    {} as PromiseDictionary<P>
  );
}

function createAtomReadOnly<T>(
  generate: () => AsyncGenerator<T, void>,
  defaultValue?: T | Partial<T>
): AtomReadOnly<T> {
  let currentValue = defaultValue as T;
  let nextValuePromise: Promise<T>;
  const subscriptions: ((newValue: T) => void)[] = [];
  const state = generate();
  let stateDone = false;
  const trackValue = () => {
    const next = state.next();
    nextValuePromise = next.then(({ done, value }) => {
      if (!done) {
        currentValue = value as T;
        subscriptions.map(listener => listener(currentValue));
        return currentValue;
      }
      stateDone = true;
      return nextValuePromise;
    });
    next.then(({ done }) => !done && trackValue());
  };
  trackValue();
  return {
    default: defaultValue,
    [Symbol.asyncIterator]: async function* () {
      yield currentValue;
      while (!stateDone) {
        yield await nextValuePromise;
      }
    },
    get: async () => currentValue,
    subscribe: listener => subscriptions.push(listener),
    select<S>(callback: (ownValue: T) => S | Promise<S>) {
      const atom = this;
      return createAtomReadOnly(async function* () {
        for await (const value of atom) {
          yield await callback(value);
        }
      });
    },
    reflect<S>(
      atom: Atom<S>,
      callback: (atomValue: S, ownValue: T) => Promise<T>
    ): AtomReadOnly<T> {
      const aggregated = aggregate(
        [atom, this],
        ([atomValuePromise, ownValuePromise]) => {
          const references = promiseDictionary({
            atom: atomValuePromise,
            own: ownValuePromise,
          });
          return Promise.race([references.atom, references.own]);
        }
      )();
      const a = createAtomReadOnly(async function* () {
        let ownValue = defaultValue as T;
        for await (const { key, value } of aggregated) {
          if (key === 'own') {
            ownValue = value as T;
            yield ownValue;
          } else if (typeof ownValue !== 'undefined') {
            yield await callback(value as S, ownValue);
          }
        }
      }, defaultValue);
      return a;
    },
    map<S>(
      callback: (newValue: T) => Promise<S> | AsyncIterable<S>,
      options?: WithDefault<S>
    ) {
      const sourceAtom = this;
      const defaultDestinationValue = options?.default;
      return createAtomReadOnly(async function* () {
        if (typeof defaultDestinationValue !== 'undefined') {
          yield defaultDestinationValue as S;
        }
        for await (const newValue of sourceAtom) {
          const destinationState = callback(newValue) as any;
          if (destinationState.then) {
            const promiseState = destinationState as Promise<S>;
            yield await promiseState;
          } else {
            const generatorState = destinationState as AsyncIterable<S>;
            for await (const newDestinationValue of generatorState) {
              yield newDestinationValue;
            }
          }
        }
      }, defaultDestinationValue);
    },
  };
}

function createAtomReadWrite<T>(
  generate: () => AsyncGenerator<T, void>,
  { set }: AsyncWritable<T>,
  defaultValue?: T | Partial<T>
): AtomReadWrite<T> {
  return {
    ...createAtomReadOnly(generate, defaultValue),
    set,
  };
}

export function selector<T>({ get }: AsyncReadable<T>): AtomReadOnly<T>;
export function selector<T>({ get, set }: AsyncReadWrite<T>): AtomReadWrite<T>;
export function selector<T>(
  generator: () => AsyncGenerator<T>
): AtomReadOnly<T>;
export function selector<T, S>(
  iterables: AsyncIterable<S>[],
  aggregator: (eachIteration: Promise<S>[]) => Promise<T>
): AtomReadOnly<T>;
export function selector<T, S>(
  firstArgument:
    | AsyncReadable<T>
    | AsyncReadWrite<T>
    | AsyncIterable<S>[]
    | (() => AsyncGenerator<T>),
  aggregator?: (eachIteration: Promise<S>[]) => Promise<T>
): Atom<T> {
  if (typeof firstArgument === 'function') {
    return createAtomReadOnly(firstArgument);
  }
  if (typeof aggregator === 'function') {
    const iterables = firstArgument as AsyncIterable<S>[];
    return createAtomReadOnly(aggregate(iterables, aggregator));
  }

  const generate = async function* () {
    yield await (firstArgument as AsyncReadable<T>).get();
  };
  let atom: Atom<T>;
  if ((firstArgument as Partial<AsyncWritable<T>>).set) {
    atom = createAtomReadWrite(generate, firstArgument as AsyncWritable<T>);
  } else {
    atom = createAtomReadOnly(generate);
  }
  return atom;
}

export function atom<T>({
  key,
  store,
  default: defaultValue,
}: {
  key: any;
  store: any;
  default?: T | Partial<T>;
}): AtomReadWrite<T> {
  const getStore = stores.get(store) as SetAndGenerateFromKey<T, any>;
  if (!getStore) {
    throw new Error('Passed "storage" has not been registered.');
  }
  const { generate, set } = getStore(key);
  return createAtomReadWrite(generate, { set }, defaultValue);
}

export function registerStore<K, V>(
  store: any,
  getStateFromKey: SetAndGenerateFromKey<V, K>
) {
  stores.set(store, getStateFromKey);
}

type JsonPrimitives = string | number | boolean | null;

type Json = JsonPrimitives | Array<Json> | { [key: string]: Json };

export const registerStorage = (storage: Storage) =>
  registerStore<string, Json>(storage, key => {
    let [newValueFromSetPromise, resolve] = resolveLater<Json>();
    return {
      async set(newValue) {
        storage.setItem(key, JSON.stringify(newValue));
        resolve(newValue);
        [newValueFromSetPromise, resolve] = resolveLater<Json>();
      },
      generate: async function* () {
        while (true) {
          const [newValueFromEventPromise, resolve] = resolveLater<Json>();
          window.addEventListener(
            'storage',
            event => {
              console.log(key);
              console.log(event.newValue);
              console.log('-----');
              event.key === key &&
                event.storageArea === storage &&
                resolve(event.newValue && JSON.parse(event.newValue));
            },
            { once: true }
          );
          const newValue = await Promise.any([
            newValueFromEventPromise,
            newValueFromSetPromise,
          ]);
          yield newValue;
          console.log(key);
          console.log(newValue);
          console.log('-----');
        }
      },
    };
  });

registerStorage(localStorage);
registerStorage(sessionStorage);

export function tracker() {
  let [newEntry, flagNewEntry] = resolveLater();
  const queue: Promise<any>[] = [newEntry];
  const waitForPromisesInQueue = async () => {
    while (queue.length > 0) {
      const promise = queue.pop();
      await promise;
    }
    [newEntry, flagNewEntry] = resolveLater();
  };

  const track = <T>(promise: Promise<T>) => {
    queue.push(promise);
    flagNewEntry();
    return promise;
  };

  const generate = async function* () {
    while (true) {
      await waitForPromisesInQueue();
      yield false;
      await newEntry;
      yield true;
    }
  };

  return {
    track,
    suspended: createAtomReadOnly(generate, true),
  };
}

export function useAtomState<T>(
  atom: AtomReadWrite<T>
): [T, (newValue: T) => void] {
  const [value, setValue] = useState<T>(atom.default as T);

  useEffect(() => {
    atom.get().then(newValue => {
      console.log('newValue');
      console.log(newValue);
      setValue(newValue);
    });
    atom.subscribe(newValue => {
      console.log('subs');
      setValue(newValue);
    });
  }, [atom]);

  return [value, atom.set];
}

export function useAtomValue<T>(atom: Atom<T>) {
  return useAtomState(atom as AtomReadWrite<T>)[0];
}

export function useSetAtomState<T>(atom: Atom<T>) {
  return useAtomState(atom as AtomReadWrite<T>)[1];
}

// export const queryStorage = {
//   invalidateQueries(key: string) {},
// };

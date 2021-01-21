import { useMemo } from 'react';

const defaultTimeout = 200;

export function buffer<T>(
  callback: (value: T) => void,
  timeout = defaultTimeout
) {
  let bufferedValue: T;
  const queue: Promise<void>[] = [];
  let consuming = false;
  const consume = async () => {
    if (consuming) return;
    consuming = true;
    while (queue.length > 0) await queue.pop();
    consuming = false;
    callback(bufferedValue);
  };
  return (value: T) => {
    bufferedValue = value;
    queue.push(new Promise(resolve => setTimeout(resolve, timeout)));
    consume();
  };
}

export function useBuffer<T>(
  callback: (value: T) => void,
  timeout = defaultTimeout
) {
  return useMemo(() => buffer(callback, timeout), [callback, timeout]);
}

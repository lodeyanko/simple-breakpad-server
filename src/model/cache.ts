let cache: Record<string, any> = {};

export default {
  clear: () => { cache = {}; },
  get: (id: string | number) => cache[id],
  set: (id: string | number, data: any) => { cache[id] = data; },
  has: (id: string | number) => Object.prototype.hasOwnProperty.call(cache, id)
};

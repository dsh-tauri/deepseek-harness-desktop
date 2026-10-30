type ServiceMethod = (...args: any[]) => any

export function defineService<T extends Record<string, ServiceMethod>>(service: T): T {
  return service
}

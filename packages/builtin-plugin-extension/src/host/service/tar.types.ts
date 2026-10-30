export interface ExtractOptions {
  stripComponents?: number
}

export interface TarHeader {
  name: string
  size: number
  type: string
}

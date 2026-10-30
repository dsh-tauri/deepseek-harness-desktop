export interface GitHubSource {
  owner: string
  repo: string
  ref?: string
  label: string
  githubUrl: string
  tarballUrl: string
}

export interface DetectedRoots {
  roots: string[]
  single: boolean
}

export function isC2StaticAppUrlAllowedV1(value: string, artifactId: string, version: string): boolean {
  try {
    const url = new URL(value)
    const firstSegment = url.pathname.split('/').filter(Boolean)[0]
    return url.protocol === 'xiaogui-app:'
      && !url.username
      && !url.password
      && !url.port
      && decodeURIComponent(url.hostname) === artifactId
      && firstSegment !== undefined
      && decodeURIComponent(firstSegment) === version
  } catch {
    return false
  }
}

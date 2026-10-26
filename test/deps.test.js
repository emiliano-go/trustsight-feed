import { describe, expect, it } from 'vitest'
import { parseDependencies } from '../src/deps.js'

describe('PKGBUILD dependency reader', () => {
  it('reads quoted, bare, versioned and arch-specific entries', () => {
    const parsed = parseDependencies(`
depends=('glibc' 'openssl>=3' "zlib")
makedepends=(git
             cmake)
checkdepends=('python-pytest')
depends_x86_64=('lib32-glibc')
`)
    expect(parsed.depends).toEqual(['glibc', 'openssl', 'zlib', 'lib32-glibc'])
    expect(parsed.makedepends).toEqual(['git', 'cmake'])
    expect(parsed.checkdepends).toEqual(['python-pytest'])
  })

  it('drops optdepends descriptions and separates dynamic entries', () => {
    const parsed = parseDependencies(
      "optdepends=('foo: optional integration' 'bar: another')\n" +
      "depends=('${pkgnames[@]}' 'static')\n",
    )
    expect(parsed.optdepends).toEqual(['foo', 'bar'])
    expect(parsed.depends).toEqual(['static'])
    expect(parsed.dynamic).toEqual(['${pkgnames[@]}'])
  })
})

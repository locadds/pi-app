import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'

import {
  canonicalizeC2ArtifactReleaseForSignatureV1,
  type C2ArtifactReleaseRefV1,
} from '@shared/xiaogui-c2-artifact'
import { C2ArchiveInstallerV1, type C2ArtifactTrustRootV1 } from './archive-installer'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function signedSkillFixture() {
  const keys = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const zip = new JSZip()
  zip.file('SKILL.md', '# Audited skill')
  zip.file('assets/readme.txt', 'controlled resource')
  const archiveBytes = await zip.generateAsync({ type: 'nodebuffer' })
  const trustRoot: C2ArtifactTrustRootV1 = {
    algorithm: 'Ed25519',
    keyId: 'test-ed25519:key-1',
    publicKeyPem: keys.publicKey,
  }
  const unsigned: C2ArtifactReleaseRefV1 = {
    artifactId: 'audited-skill',
    releaseId: 'release-1',
    kind: 'SKILL',
    name: 'Audited Skill',
    summary: 'fixture',
    version: '1.0.0',
    manifestSchemaVersion: '1',
    entrypoint: 'SKILL.md',
    registryRef: 'c2:opaque',
    packageSha256: createHash('sha256').update(archiveBytes).digest('hex'),
    signature: 'pending',
    signatureKeyId: trustRoot.keyId,
    publicKeyPem: trustRoot.publicKeyPem,
    compatibility: { minXiaoguiVersion: '0.3.0', supportedModes: ['WORK'] },
    permissions: ['skill:read-local-selection'],
    reviewState: 'PUBLISHED',
  }
  const signature = sign(
    null,
    Buffer.from(canonicalizeC2ArtifactReleaseForSignatureV1(unsigned), 'utf8'),
    keys.privateKey,
  ).toString('base64')
  return { archiveBytes, release: { ...unsigned, signature }, trustRoot, privateKeyPem: keys.privateKey }
}

describe('C2ArchiveInstallerV1', () => {
  it('verifies a signed compatible Skill ZIP and atomically replaces only its controlled target', async () => {
    const fixture = await signedSkillFixture()
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-c2-archive-'))
    roots.push(root)
    const targetDirectory = join(root, 'skills', 'audited-skill')
    mkdirSync(targetDirectory, { recursive: true })
    writeFileSync(join(targetDirectory, 'obsolete.txt'), 'old')

    const installer = new C2ArchiveInstallerV1({
      trustRoot: fixture.trustRoot,
      currentXiaoguiVersion: '0.3.0-rc.1',
      supportedModes: ['WORK', 'DESIGN', 'CODING'],
    })
    const result = await installer.verifyAndInstall({
      release: fixture.release,
      archiveBytes: fixture.archiveBytes,
      targetDirectory,
    })

    expect(result).toEqual({
      artifactId: 'audited-skill',
      kind: 'SKILL',
      targetDirectory,
      entrypointPath: join(targetDirectory, 'SKILL.md'),
    })
    expect(readFileSync(join(targetDirectory, 'SKILL.md'), 'utf8')).toBe('# Audited skill')
    expect(() => readFileSync(join(targetDirectory, 'obsolete.txt'))).toThrow()
  })

  it('fails closed before installation on key, signature, hash, compatibility, or ZIP policy mismatch', async () => {
    const fixture = await signedSkillFixture()
    const root = mkdtempSync(join(tmpdir(), 'xiaogui-c2-reject-'))
    roots.push(root)
    const targetDirectory = join(root, 'skills', 'audited-skill')
    const installer = new C2ArchiveInstallerV1({
      trustRoot: fixture.trustRoot,
      currentXiaoguiVersion: '0.2.9',
      supportedModes: ['WORK'],
    })

    await expect(installer.verifyAndInstall({
      release: fixture.release,
      archiveBytes: fixture.archiveBytes,
      targetDirectory,
    })).rejects.toThrow(/compatible/i)

    const compatible = new C2ArchiveInstallerV1({
      trustRoot: fixture.trustRoot,
      currentXiaoguiVersion: '0.3.0',
      supportedModes: ['WORK'],
    })
    await expect(compatible.verifyAndInstall({
      release: { ...fixture.release, signatureKeyId: 'attacker' },
      archiveBytes: fixture.archiveBytes,
      targetDirectory,
    })).rejects.toThrow(/key/i)
    await expect(compatible.verifyAndInstall({
      release: { ...fixture.release, signature: Buffer.alloc(64).toString('base64') },
      archiveBytes: fixture.archiveBytes,
      targetDirectory,
    })).rejects.toThrow(/signature/i)
    await expect(compatible.verifyAndInstall({
      release: fixture.release,
      archiveBytes: Buffer.concat([fixture.archiveBytes, Buffer.from('tampered')]),
      targetDirectory,
    })).rejects.toThrow(/SHA-256/i)

    const unsafe = new JSZip()
    unsafe.file('../escape.txt', 'escape')
    unsafe.file('SKILL.md', '# unsafe')
    const unsafeBytes = await unsafe.generateAsync({ type: 'nodebuffer' })
    const unsafeUnsigned = { ...fixture.release, packageSha256: createHash('sha256').update(unsafeBytes).digest('hex') }
    const unsafeRelease = {
      ...unsafeUnsigned,
      signature: sign(
        null,
        Buffer.from(canonicalizeC2ArtifactReleaseForSignatureV1(unsafeUnsigned), 'utf8'),
        fixture.privateKeyPem,
      ).toString('base64'),
    }
    await expect(compatible.verifyAndInstall({
      release: unsafeRelease,
      archiveBytes: unsafeBytes,
      targetDirectory,
    })).rejects.toThrow(/unsafe/i)
    expect(() => readFileSync(join(root, 'escape.txt'))).toThrow()

    const reparseBytes = Buffer.from(fixture.archiveBytes)
    const centralOffset = reparseBytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    expect(centralOffset).toBeGreaterThanOrEqual(0)
    reparseBytes.writeUInt16LE((10 << 8) | 20, centralOffset + 4)
    reparseBytes.writeUInt32LE(0x00000400, centralOffset + 38)
    const reparseUnsigned = {
      ...fixture.release,
      packageSha256: createHash('sha256').update(reparseBytes).digest('hex'),
    }
    const reparseRelease = {
      ...reparseUnsigned,
      signature: sign(
        null,
        Buffer.from(canonicalizeC2ArtifactReleaseForSignatureV1(reparseUnsigned), 'utf8'),
        fixture.privateKeyPem,
      ).toString('base64'),
    }
    await expect(compatible.verifyAndInstall({
      release: reparseRelease,
      archiveBytes: reparseBytes,
      targetDirectory,
    })).rejects.toThrow(/link|special|reparse|forbidden/i)
  })
})

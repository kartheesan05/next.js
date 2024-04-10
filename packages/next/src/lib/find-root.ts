import { dirname } from 'path'
import findUp from 'find-up'

export function findRootLockFile(cwd: string) {
  return findUp.sync(
    ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lockb'],
    {
      cwd,
    }
  )
}

export function findRootDir(cwd: string) {
  const lockFile = findRootLockFile(cwd)
  return lockFile ? dirname(lockFile) : undefined
}

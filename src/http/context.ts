import type { Config } from '../config'
import type { Db } from '../db/client'
import type { Permission, Role } from '../auth/permissions'
import type { Bindings } from '../env'
import type { FileStore } from '../files/store'

export type Principal = { staffId: string; clinicId: string; name: string; role: Role; permissions: ReadonlySet<Permission>; sessionHash: string }
export type Deps = { db: (env: Bindings) => Db; now?: () => number; files?: (env: Bindings) => FileStore }
export type AppEnv = { Bindings: Bindings; Variables: { requestId: string; config: Config; db: Db; files: FileStore; now: number; principal: Principal } }

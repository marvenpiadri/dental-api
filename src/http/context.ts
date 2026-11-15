import type { Config } from '../config'
import type { Db } from '../db/client'
import type { Permission, Role } from '../auth/permissions'
import type { Bindings } from '../env'

export type Principal = { staffId: string; clinicId: string; name: string; role: Role; permissions: ReadonlySet<Permission>; sessionHash: string }
export type Deps = { db: (env: Bindings) => Db; now?: () => number }
export type AppEnv = { Bindings: Bindings; Variables: { requestId: string; config: Config; db: Db; now: number; principal: Principal } }

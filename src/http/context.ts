import type { Config } from '../config'
import type { Db, PgDb } from '../db/client'
import type { Permission, Role } from '../auth/permissions'
import type { Bindings } from '../env'
import type { FileStore } from '../files/store'
import type { PasswordService } from '../auth/password-service'

export type Principal = { staffId: string; clinicId: string; name: string; role: Role; permissions: ReadonlySet<Permission>; sessionHash: string }
export type Deps = { db: (env: Bindings) => Db | PgDb; now?: () => number; files?: (env: Bindings) => FileStore; passwords?: (env: Bindings) => PasswordService }
export type AppEnv = { Bindings: Bindings; Variables: { requestId: string; config: Config; db: Db; files: FileStore; passwords: PasswordService; now: number; principal: Principal } }

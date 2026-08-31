import { WorkMaterialsServiceV1 } from './work-materials-service'

let defaultService: WorkMaterialsServiceV1 | null = null

export function getDefaultWorkMaterialsServiceV1(): WorkMaterialsServiceV1 {
  defaultService ??= new WorkMaterialsServiceV1()
  return defaultService
}

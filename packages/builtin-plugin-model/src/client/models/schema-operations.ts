import type {
  SettingsSchemaService,
} from '@deepseek-ai/dsh-client-ui-settings/client'

export type SettingsSchemaOperations = Pick<
  SettingsSchemaService,
  'rehydrate' | 'validate' | 'nodeAtPath' | 'getPath' | 'hasPath' | 'setPath' | 'deletePath'
>

export function createSettingsSchemaOperations(service: SettingsSchemaService): SettingsSchemaOperations {
  return {
    rehydrate: serialized => service.rehydrate(serialized),
    validate: (schema, draft) => service.validate(schema, draft),
    nodeAtPath: (root, path) => service.nodeAtPath(root, path),
    getPath: (value, path) => service.getPath(value, path),
    hasPath: (value, path) => service.hasPath(value, path),
    setPath: (root, path, value) => service.setPath(root, path, value),
    deletePath: (root, path) => service.deletePath(root, path),
  }
}

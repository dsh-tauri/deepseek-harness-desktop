import { cssr } from 'dsh-tauri-ui/client'
import { modelStyles } from './styles'

const { c } = cssr

export const modelsOverridesNode = c([`
.${modelStyles.modelListHead}.${modelStyles.modelListHead} {
  flex-wrap: wrap;
}

.${modelStyles.modelCatalogHeading}.${modelStyles.modelCatalogHeading} {
  flex: 1 0 auto;
}

.${modelStyles.modelRow}.${modelStyles.modelRow} {
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, auto) auto auto;
}

.${modelStyles.modelInputTypes}.${modelStyles.modelInputTypes} {
  grid-column: auto;
  order: 2;
}

.dshp-models-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
`])

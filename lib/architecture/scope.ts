import type { ArchitectureData } from '@/lib/models/types'

export function isInScope(component: ArchitectureData['components'][number]): boolean {
  return !component.relationship || component.relationship === 'system' || component.relationship === 'dependency'
}

/** Preserve classifications in the stored model, but never analyze contextual systems as dependencies. */
export function scopedArchitecture(architecture: ArchitectureData): ArchitectureData {
  const excluded = new Set(architecture.components.filter(c => !isInScope(c)).map(c => c.name.toLowerCase()))
  if (!excluded.size) return architecture
  const included = (name: string) => !excluded.has(name.toLowerCase())
  return {
    ...architecture,
    components: architecture.components.filter(isInScope),
    dataFlows: architecture.dataFlows.filter(f => included(f.from) && included(f.to)),
    externalEntities: architecture.externalEntities.filter(included),
    dataStores: architecture.dataStores.filter(included),
    detailedTopology: architecture.detailedTopology ? {
      ...architecture.detailedTopology,
      securityConfigs: architecture.detailedTopology.securityConfigs?.filter(c => included(c.component)),
      environmentVars: architecture.detailedTopology.environmentVars?.filter(c => included(c.component)),
    } : undefined,
    factLedger: architecture.factLedger ? {
      ...architecture.factLedger,
      controls: architecture.factLedger.controls.filter(c => !c.component || included(c.component)),
      assumptions: [...architecture.factLedger.assumptions, `Excluded contextual systems (not current dependencies): ${[...excluded].join(', ')}`],
    } : undefined,
  }
}

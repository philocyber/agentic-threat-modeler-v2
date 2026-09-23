export const RAG_INDEX_FORMAT_VERSION = 6
export const TECHNICAL_CHUNK_SIZE = 1_200
export const TECHNICAL_CHUNK_OVERLAP = 180
export const CORPORATE_CHUNK_SIZE = 1_800
export const CORPORATE_CHUNK_OVERLAP = 120
export const RAG_PASSAGE_MAX_CHARACTERS = 2_400
export const RAG_MAX_QUERIES_PER_RUN = 40

export const TECHNICAL_EXTENSIONS = ['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.pdf'] as const
export const CORPORATE_EXTENSIONS = ['.md', '.txt', '.json', '.yaml', '.yml'] as const

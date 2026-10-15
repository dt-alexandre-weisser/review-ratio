import { CONTRACT_VERSION_1 } from './v1.ts';

/** Every contract major that exists. Whether a major is still accepted is a server decision. */
export const CONTRACT_MAJORS = [CONTRACT_VERSION_1] as const;

/** The major a freshly built extension speaks. */
export const LATEST_CONTRACT_VERSION = CONTRACT_VERSION_1;

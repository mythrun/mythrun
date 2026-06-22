import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// Join conditional class names (clsx) and resolve conflicting Tailwind
// utilities so the last one wins (twMerge). The single class-composition
// helper for the whole library.
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs))

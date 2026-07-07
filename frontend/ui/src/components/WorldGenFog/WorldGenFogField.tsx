import { forwardRef, useCallback, useRef } from 'react'
import { FOG_PARAMS } from '@mythrun/client-core/worldgen'
import type { WorldGenFogFieldProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { useFogCanvas } from './use-fog-canvas.ts'

// WorldGenFogField (MYT-89 Phase C, C3) — the decorative FOG layer of the world-gen
// loading experience: rolling clouds that part and close around the streaming entity
// labels and FADE toward nothing as the graph fills. This is JUST the fog layer (§5,
// layered canvases): it renders an `absolute inset-0` canvas meant to sit BEHIND the
// graph canvas in a shared positioned container, and never draws the entities themselves.
//
// The canvas is decorative (aria-hidden) — the graph's accessible entity list carries all
// meaning, so the fog contributes nothing to the a11y tree. All the imperative work
// (the fixed-timestep sim loop, obstacle construction, the 900×470 virtual space + CSS
// scale, reduced motion) lives in useFogCanvas; this component is thin composition.

export const WorldGenFogField = forwardRef<HTMLCanvasElement, WorldGenFogFieldProps>(
  function WorldGenFogField(
    {
      entities = [],
      entitiesSource,
      shownEntities,
      totalEntities,
      density = FOG_PARAMS.density,
      reducedMotion = false,
      growth,
      'data-testid': dataTestId,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    // Merge the forwarded ref with the internal one the loop draws through, so a
    // consumer can still grab the canvas without stealing it from the controller.
    const setCanvas = useCallback(
      (el: HTMLCanvasElement | null): void => {
        canvasRef.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref !== null) ref.current = el
      },
      [ref],
    )

    useFogCanvas({ canvasRef, entities, entitiesSource, shownEntities, totalEntities, density, reducedMotion, growth })

    return (
      <canvas
        ref={setCanvas}
        aria-hidden="true"
        {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
        className={cn('absolute inset-0 block h-full w-full')}
      />
    )
  },
)

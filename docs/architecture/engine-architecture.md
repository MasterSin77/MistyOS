# Engine Architecture Contract

## Purpose

Define the non-negotiable architectural contract for candidate engine implementation.

## Canonical Truth

The wet surface is canonical simulation truth and must remain GPU-resident. CPU cannot author wetness texture truth.

## CPU Responsibilities

- Event injection (rain, writing, wiping disturbances)
- Seed control and deterministic mode orchestration
- Parameter updates and scenario timelines
- Capture mode control and checkpoint export scheduling

## GPU Responsibilities

- Wetness/water mass updates
- Flow/slip advection transport
- Disturbance propagation and decay
- Droplet density emergence from shared state
- Optical gradient and normal derivation from shared state

## Pass Graph Order (M1)

1. Deposition
2. Advection
3. Coalescence
4. Disturbance propagation/decay
5. Evaporation/drying
6. Optical derivative reconstruction
7. Render

## Prohibited Patterns

- CPU-authored wetness texture stack
- Sprite-only decorative droplet system as behavior truth
- Isolated optical/wetness layers not round-tripped into shared state
- Post-composited runoff or mist disconnected from surface simulation

## Backend Strategy

- M1: WebGPU-first implementation
- Post-M1 stabilization: WebGL2 fallback path matching the same scenario and validation contracts

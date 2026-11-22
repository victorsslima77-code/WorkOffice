declare module 'easystarjs' {
  export interface PathPoint {
    x: number;
    y: number;
  }

  export class js {
    setGrid(grid: number[][]): void;
    setAcceptableTiles(tiles: number[] | number): void;
    enableDiagonals(): void;
    disableDiagonals(): void;
    enableCornerCutting(): void;
    disableCornerCutting(): void;
    findPath(
      startX: number,
      startY: number,
      endX: number,
      endY: number,
      callback: (path: PathPoint[] | null) => void,
    ): number;
    calculate(): void;
  }
}

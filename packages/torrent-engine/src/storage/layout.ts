import type { TorrentFileEntry } from '../metainfo.js';
import { BLOCK_SIZE } from '../peer/messages.js';

export interface FileSpan {
  file: TorrentFileEntry;
  /** Offset inside the file. */
  fileOffset: number;
  length: number;
  /** Offset of this span relative to the start of the requested range. */
  rangeOffset: number;
}

/** Maps pieces and blocks onto the files of a (multi-file) torrent. */
export class PieceLayout {
  readonly pieceCount: number;
  private readonly fileStarts: number[];

  constructor(
    readonly files: readonly TorrentFileEntry[],
    readonly pieceLength: number,
    readonly totalLength: number,
  ) {
    this.pieceCount = Math.ceil(totalLength / pieceLength);
    this.fileStarts = files.map((f) => f.offset);
  }

  pieceSize(i: number): number {
    if (i < 0 || i >= this.pieceCount) return 0;
    return i === this.pieceCount - 1 ? this.totalLength - i * this.pieceLength : this.pieceLength;
  }

  blocksInPiece(i: number): number {
    return Math.ceil(this.pieceSize(i) / BLOCK_SIZE);
  }

  blockSize(i: number, block: number): number {
    const size = this.pieceSize(i);
    return Math.min(BLOCK_SIZE, size - block * BLOCK_SIZE);
  }

  /** True when (piece, begin, length) names a valid block-aligned range. */
  isValidBlock(i: number, begin: number, length: number): boolean {
    const size = this.pieceSize(i);
    return size > 0 && begin >= 0 && length > 0 && begin + length <= size && length <= BLOCK_SIZE * 2;
  }

  private firstFileAt(offset: number): number {
    // binary search: last file whose start <= offset
    let lo = 0;
    let hi = this.fileStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.fileStarts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** File spans covering the torrent byte range [offset, offset + length). Skips empty files. */
  spans(offset: number, length: number): FileSpan[] {
    const out: FileSpan[] = [];
    let pos = offset;
    const end = offset + length;
    for (let i = this.firstFileAt(offset); i < this.files.length && pos < end; i++) {
      const f = this.files[i] as TorrentFileEntry;
      const fEnd = f.offset + f.length;
      if (f.length === 0 || fEnd <= pos) continue;
      const take = Math.min(end, fEnd) - pos;
      out.push({ file: f, fileOffset: pos - f.offset, length: take, rangeOffset: pos - offset });
      pos += take;
    }
    return out;
  }

  pieceSpans(i: number, begin = 0, length = this.pieceSize(i) - begin): FileSpan[] {
    return this.spans(i * this.pieceLength + begin, length);
  }

  /** Indices of the (non-empty) files that piece `i` touches. */
  filesForPiece(i: number): number[] {
    return this.pieceSpans(i).map((s) => s.file.index);
  }

  /** Inclusive piece range of a file, or null for empty files. */
  pieceRange(fileIndex: number): [number, number] | null {
    const f = this.files[fileIndex];
    if (!f || f.length === 0) return null;
    return [Math.floor(f.offset / this.pieceLength), Math.floor((f.offset + f.length - 1) / this.pieceLength)];
  }
}

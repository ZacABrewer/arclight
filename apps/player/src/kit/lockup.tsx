import lockupUrl from '../../../../design/brand/lockup-dark-bg.svg?url';

// The Light Slice lockup (brand rules: the lockup everywhere but small places). Stand-in for
// C's `@web/arclight/lockup` (which draws it inline so themes recolour it).
export function Lockup({ height = 22, className }: { height?: number; className?: string }) {
  return <img src={lockupUrl} alt="Arclight" className={className} style={{ height, width: 'auto', display: 'block' }} />;
}

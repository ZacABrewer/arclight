import { t } from '@web/i18n/index';
import { parsePairingLink } from '../core/qr';

export type ScanOutcome =
  | { kind: 'pairing'; server: string; code: string | null }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

/** Opens the camera for the QR code the web player shows ("Sign in to the Arclight app"). */
export async function scanPairingCode(): Promise<ScanOutcome> {
  let text: string;
  try {
    const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import('@capacitor/barcode-scanner');
    const res = await CapacitorBarcodeScanner.scanBarcode({ hint: CapacitorBarcodeScannerTypeHint.QR_CODE, scanInstructions: t('app.scan.instructions') });
    text = res.ScanResult ?? '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/cancel/i.test(message)) return { kind: 'cancelled' };
    return { kind: 'error', message: t('app.scan.failed') };
  }
  if (!text) return { kind: 'cancelled' };
  const link = parsePairingLink(text);
  if (!link) return { kind: 'error', message: t('app.scan.notPairing') };
  return { kind: 'pairing', server: link.server, code: link.code };
}

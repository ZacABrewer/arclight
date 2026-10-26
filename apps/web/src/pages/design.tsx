import { useEffect } from 'react';
import { ArclightGallery } from '../arclight/gallery.js';

/** /design (admins): every Arclight component in every state. The gallery draws its own demo shell. */
export function DesignPage() {
  useEffect(() => {
    document.title = 'Design system · Arclight';
  }, []);
  return <ArclightGallery />;
}

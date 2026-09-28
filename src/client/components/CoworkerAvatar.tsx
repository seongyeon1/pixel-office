import type { Provider } from '../../shared/contracts';
import { PixelWorker } from '../office/PixelWorker';

export function CoworkerAvatar({ id, small = false }: { id: Provider; small?: boolean }) {
  return (
    <span className={`avatar pixel-avatar ${id} ${small ? 'small' : ''}`}>
      <PixelWorker provider={id} />
    </span>
  );
}

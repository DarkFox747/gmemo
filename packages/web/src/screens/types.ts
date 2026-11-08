import type { ApiClient } from '../api/client';
import type { Route } from '../lib/hashRoute';

/** Props every screen receives from App. `role` is the membership role in the selected project. */
export interface ScreenProps {
  api: ApiClient;
  projectId: string;
  role: string;
  refreshBadges: () => void;
  navigate: (r: Route) => void;
}

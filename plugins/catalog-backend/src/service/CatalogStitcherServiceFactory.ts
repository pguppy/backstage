/*
 * Copyright 2026 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createServiceFactory } from '@backstage/backend-plugin-api';
import {
  CatalogStitcherService,
  catalogStitcherServiceRef,
} from '@backstage/plugin-catalog-node/alpha';

let stitcherPromise: Promise<CatalogStitcherService>;
let stitcherResolve: (stitcher: CatalogStitcherService) => void;

function ensurePromise() {
  if (!stitcherPromise) {
    ({ promise: stitcherPromise, resolve: stitcherResolve } =
      Promise.withResolvers<CatalogStitcherService>());
  }
}

/** @internal */
export function _setStitcher(stitcher: CatalogStitcherService) {
  ensurePromise();
  stitcherResolve(stitcher);
}

/**
 * Reset the stitcher reference. For use in tests to isolate
 * between test cases that initialize the catalog plugin.
 *
 * @internal
 */
export function _resetStitcher() {
  stitcherPromise = undefined as any;
  stitcherResolve = undefined as any;
}

/**
 * Provides the catalog stitcher service.
 *
 * This factory returns a promise that resolves once the catalog plugin has
 * initialized and registered its stitcher. Consumers that depend on
 * `catalogStitcherServiceRef` will wait for the catalog plugin to be ready
 * rather than failing immediately.
 *
 * **Important:** The catalog plugin (`@backstage/plugin-catalog-backend`) must
 * be installed and initialized in the backend for this service to resolve.
 *
 * @alpha
 */
export const catalogStitcherServiceFactory = createServiceFactory({
  service: catalogStitcherServiceRef,
  deps: {},
  async factory() {
    ensurePromise();
    return stitcherPromise;
  },
});

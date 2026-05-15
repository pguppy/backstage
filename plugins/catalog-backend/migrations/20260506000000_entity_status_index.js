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

exports.up = async function up(knex) {
  if (!knex.client.config.client.includes('sqlite3')) {
    await knex.schema.alterTable('entity_status', table => {
      table.index('entity_ref', 'entity_status_entity_ref_idx');
    });
  }
};

exports.down = async function down(knex) {
  if (!knex.client.config.client.includes('sqlite3')) {
    await knex.schema.alterTable('entity_status', table => {
      table.dropIndex('entity_ref', 'entity_status_entity_ref_idx');
    });
  }
};

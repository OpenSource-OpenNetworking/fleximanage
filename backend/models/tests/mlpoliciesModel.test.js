// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019  flexiWAN Ltd.

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

/* eslint-disable max-len */
const MultiLinkPolicies = require('../mlpolicies');

let mLPolicyFullSchema;

beforeEach(() => {
  mLPolicyFullSchema = new MultiLinkPolicies({
    org: '5e1ae0103d49ab3d9a03c28f',
    name: 'Multilink policy name',
    description: 'Multi link policy description',
    version: 0,
    rules: [{
      name: 'Rule 1',
      priority: 0,
      enabled: true,
      classification: {
        prefix: {
          ip: '192.168.10.1/24'
        }
      },
      action: {
        links: {
          pathlabels: [
            '5e1ae0103d49ab3d9a03c28e'
          ],
          order: 'priority'
        },
        order: 'priority',
        fallback: 'drop'
      }
    }]
  });
});

describe('Minimal required multi link policy schema', () => {
  it('Should be a valid multi link policy model if all required fields are present', () => {
    mLPolicyFullSchema.validate((err) => {
      expect(err).toBe(null);
    });
  });

  it('Should be an invalid policy in policy name is missing', () => {
    mLPolicyFullSchema.name = null;
    mLPolicyFullSchema.validate((err) => {
      expect(err.message).toBe('MultiLinkPolicies validation failed: name: Path `name` is required.');
    });
  });

  it('Should be an invalid policy if policy rule name is missing', () => {
    mLPolicyFullSchema.rules[0].name = null;
    mLPolicyFullSchema.validate((err) => {
      expect(err.message).toBe('MultiLinkPolicies validation failed: rules.0.name: Path `name` is required.');
    });
  });

  it('Should be an invalid policy if policy rule priority is missing', () => {
    mLPolicyFullSchema.rules[0].priority = null;
    mLPolicyFullSchema.validate((err) => {
      expect(err.message).toBe('MultiLinkPolicies validation failed: rules.0.priority: Path `priority` is required.');
    });
  });

  it('Should be an invalid policy if policy rule enabled field is missing', () => {
    mLPolicyFullSchema.rules[0].enabled = null;
    mLPolicyFullSchema.validate((err) => {
      expect(err.message).toBe('MultiLinkPolicies validation failed: rules.0.enabled: Path `enabled` is required.');
    });
  });

  it('Should be an invalid policy if policy rule action order is missing', () => {
    mLPolicyFullSchema.rules[0].action.order = null;
    const msg = 'MultiLinkPolicies validation failed: rules.0.action.order: Path `action.order` is required.';
    mLPolicyFullSchema.validate((err) => {
      expect(err.message).toBe(msg);
    });
  });

  it('Should be an invalid policy if policy rule action fallback is missing', () => {
    mLPolicyFullSchema.rules[0].action.fallback = null;
    const msg = 'MultiLinkPolicies validation failed: rules.0.action.fallback: Path `action.fallback` is required.';
    mLPolicyFullSchema.validate((err) => {
      expect(err.message).toBe(msg);
    });
  });

  it('Should be an invalid policy if policy rule action link order is missing', () => {
    mLPolicyFullSchema.rules[0].action.links[0].order = null;
    const msg = 'MultiLinkPolicies validation failed: rules.0.action.links.0.order: Path `order` is required.';
    mLPolicyFullSchema.validate((err) => {
      expect(err.message).toBe(msg);
    });
  });
});

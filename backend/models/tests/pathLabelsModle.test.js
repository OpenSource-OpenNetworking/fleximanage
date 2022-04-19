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
const PathLabels = require('../pathlabels');

let pathLabelsFullSchema;

beforeEach(() => {
  pathLabelsFullSchema = new PathLabels({
    org: '5e1ae0103d49ab3d9a03c28f',
    name: 'Label path',
    description: 'Label path description',
    color: '#FFFFFF'
  });
});

describe('Minimal required path label schema', () => {
  it('Should be a valid path label model if all required fields are present', () => {
    pathLabelsFullSchema.validate((err) => {
      expect(err).toBe(null);
    });
  });

  it('Should be an invalid path label model if name field is missing', () => {
    pathLabelsFullSchema.name = null;

    pathLabelsFullSchema.validate((err) => {
      expect(err.message).toBe('PathLabels validation failed: name: Path `name` is required.');
    });
  });

  it('Should be an invalid path label model if org field is missing', () => {
    pathLabelsFullSchema.org = null;

    pathLabelsFullSchema.validate((err) => {
      expect(err.message).toBe('PathLabels validation failed: org: Path `org` is required.');
    });
  });

  it('Should be an invalid path label model if color field is missing', () => {
    pathLabelsFullSchema.color = null;

    pathLabelsFullSchema.validate((err) => {
      expect(err.message).toBe('PathLabels validation failed: color: Path `color` is required.');
    });
  });
});

describe('Path label schema', () => {
  it('Should be a valid path label model if all required fields are valid', () => {
    pathLabelsFullSchema.validate((err) => {
      expect(err).toBe(null);
    });
  });

  it('Should be an invalid path label model if name field is invalid', () => {
    pathLabelsFullSchema.name = 'invalid*Label*name';

    pathLabelsFullSchema.validate((err) => {
      expect(err.message).toBe('PathLabels validation failed: name: Path label name format is invalid');
    });
  });

  it('Should be an invalid path label model if description field is invalid', () => {
    pathLabelsFullSchema.description = 'invalid*description';

    pathLabelsFullSchema.validate((err) => {
      expect(err.message).toBe('PathLabels validation failed: description: Path label description format is invalid');
    });
  });

  it('Should be an invalid path label model if color field is invalid', () => {
    pathLabelsFullSchema.color = 'invalid color';

    pathLabelsFullSchema.validate((err) => {
      expect(err.message).toBe('PathLabels validation failed: color: Path label color is invalid');
    });
  });
});

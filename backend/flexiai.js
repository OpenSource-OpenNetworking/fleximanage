// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2024  flexiWAN Ltd.

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

'use strict';

/**
 * flexiAiStub class
 */
class FlexiAi {
  async chatQuery (session, query) {
    const response = { answer: 'AI System Not Running', sources: [] };
    return response;
  }

  /**
   * Singleton instance
   */
  static GetInstance () {
    if (!this.Instance) {
      this.Instance = new FlexiAi();
    }
    return this.Instance;
  }
}

// check if flexibilling is required
let flexiAi;
const useFlexiAi = require('./configs')().get('useFlexiAi', 'boolean');

if (useFlexiAi) {
  flexiAi = require('./ai');
} else {
  flexiAi = FlexiAi.GetInstance();
}

// Conditional exports
module.exports = flexiAi;

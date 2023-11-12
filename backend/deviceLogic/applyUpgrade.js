// flexiWAN SD-WAN software - flexiEdge, flexiManage.
// For more information go to https://flexiwan.com
// Copyright (C) 2019-2020  flexiWAN Ltd.

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

const configs = require('../configs')();
const deviceStatus = require('../periodic/deviceStatus')();
const DevSwUpdater = require('./DevSwVersionUpdateManager');
const deviceQueues = require('../utils/deviceQueue')(
  configs.get('kuePrefix'),
  configs.get('redisUrl')
);
const { devices } = require('../models/devices');
const { getMajorVersion, getMinorVersion } = require('../versioning');
const logger = require('../logging/logging')({ module: module.filename, type: 'job' });
const notificationsConf = require('../models/notificationsConf');

// Hold scripts to run before a version. Key = Major.Minor version, value = script to execute
const perVersionJobs = {
  // Update the fwupgrade.sh script before upgrading to 6.1 release
  // eslint-disable-next-line max-len
  6.1: 'echo IyEgL2Jpbi9iYXNoCgojIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIwojIGZsZXhpV0FOIFNELVdBTiBzb2Z0d2FyZSAtIGZsZXhpRWRnZSwgZmxleGlNYW5hZ2UuCiMgRm9yIG1vcmUgaW5mb3JtYXRpb24gZ28gdG8gaHR0cHM6Ly9mbGV4aXdhbi5jb20KIwojIENvcHlyaWdodCAoQykgMjAyMyAgZmxleGlXQU4gTHRkLgojCiMgVGhpcyBwcm9ncmFtIGlzIGZyZWUgc29mdHdhcmU6IHlvdSBjYW4gcmVkaXN0cmlidXRlIGl0IGFuZC9vciBtb2RpZnkgaXQgdW5kZXIKIyB0aGUgdGVybXMgb2YgdGhlIEdOVSBBZmZlcm8gR2VuZXJhbCBQdWJsaWMgTGljZW5zZSBhcyBwdWJsaXNoZWQgYnkgdGhlIEZyZWUKIyBTb2Z0d2FyZSBGb3VuZGF0aW9uLCBlaXRoZXIgdmVyc2lvbiAzIG9mIHRoZSBMaWNlbnNlLCBvciAoYXQgeW91ciBvcHRpb24pIGFueQojIGxhdGVyIHZlcnNpb24uCiMKIyBUaGlzIHByb2dyYW0gaXMgZGlzdHJpYnV0ZWQgaW4gdGhlIGhvcGUgdGhhdCBpdCB3aWxsIGJlIHVzZWZ1bCwKIyBidXQgV0lUSE9VVCBBTlkgV0FSUkFOVFk7IHdpdGhvdXQgZXZlbiB0aGUgaW1wbGllZCB3YXJyYW50eSBvZiBNRVJDSEFOVEFCSUxJVFkKIyBvciBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRS4KIyBTZWUgdGhlIEdOVSBBZmZlcm8gR2VuZXJhbCBQdWJsaWMgTGljZW5zZSBmb3IgbW9yZSBkZXRhaWxzLgojCiMgWW91IHNob3VsZCBoYXZlIHJlY2VpdmVkIGEgY29weSBvZiB0aGUgR05VIEFmZmVybyBHZW5lcmFsIFB1YmxpYyBMaWNlbnNlCiMgYWxvbmcgd2l0aCB0aGlzIHByb2dyYW0uIElmIG5vdCwgc2VlIDxodHRwczovL3d3dy5nbnUub3JnL2xpY2Vuc2VzLz4uCiMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjCgojIENvbnN0YW50cwpBR0VOVF9TRVJWSUNFX0ZJTEU9Jy9saWIvc3lzdGVtZC9zeXN0ZW0vZmxleGl3YW4tcm91dGVyLnNlcnZpY2UnCkFHRU5UX1NFUlZJQ0U9J2ZsZXhpd2FuLXJvdXRlcicKU1dfUkVQT1NJVE9SWT0nZGViLmZsZXhpd2FuLmNvbScKQUdFTlRfQ0hFQ0tfVElNRU9VVD0zNjAKCiMgQ29uc3RhbnRzIHBhc3NlZCB0byB0aGUgc2NyaXB0IGJ5IGZ3YWdlbnQKVEFSR0VUX1ZFUlNJT049IiQxIgpWRVJTSU9OU19GSUxFPSIkMiIKVVBHUkFERV9GQUlMVVJFX0ZJTEU9IiQzIgpBR0VOVF9MT0dfRklMRT0iJDQiCgojIEdsb2JhbHMKcHJldl92ZXI9JycKCmxvZygpIHsKICAgIGVjaG8gYGRhdGUgKyclYiAlZSAlUjolUydgIiAkSE9TVE5BTUU6IGZ3dXBncmFkZTogIiAiJEAiID4+ICIkQUdFTlRfTE9HX0ZJTEUiIDI+JjEKfQoKaGFuZGxlX3VwZ3JhZGVfZmFpbHVyZSgpIHsKICAgIGxvZyAiU29mdHdhcmUgdXBncmFkZSBmYWlsZWQiCgogICAgIyBSZXZlcnQgYmFjayB0byBwcmV2aW91cyB2ZXJzaW9uIGlmIHJlcXVpcmVkCiAgICBpZiBbICIkMSIgPT0gJ3JldmVydCcgXTsgdGhlbgogICAgICAgIGxvZyAicmV2ZXJ0aW5nIHRvIHByZXZpb3VzIHZlcnNpb24gJHtwcmV2X3Zlcn0gLi4uIgoKICAgICAgICBhcHRfaW5zdGFsbCAiJHtBR0VOVF9TRVJWSUNFfT0ke3ByZXZfdmVyfSIKICAgICAgICByZXQ9JHtQSVBFU1RBVFVTWzBdfQogICAgICAgIGlmIFsgJHtyZXR9ID09IDEgXTsgdGhlbgogICAgICAgICAgICBsb2cgImZhaWxlZCB0byByZXZlcnQgdG8gJHtwcmV2X3Zlcn0gd2l0aCAke3JldH0gLSBleGl0LiIKICAgICAgICAgICAgZXhpdCAxCiAgICAgICAgZWxpZiBbICR7cmV0fSA9PSAyIF07IHRoZW4KICAgICAgICAgICAgbG9nICJmYWlsZWQgdG8gcmV2ZXJ0IHRvICR7cHJldl92ZXJ9IHdpdGggJHtyZXR9IC0gcmVzdGFydCBhZ2VudCIKICAgICAgICAgICAgIyBBZ2VudCBtdXN0IGJlIHJlc3RhcnRlZCBpZiByZXZlcnQgZmFpbHMsIG9yIG90aGVyd2lzZQogICAgICAgICAgICAjIGl0IHdpbGwgcmVtYWluIHN0b3BwZWQuCiAgICAgICAgICAgIHN5c3RlbWN0bCByZXN0YXJ0ICIkQUdFTlRfU0VSVklDRSIKICAgICAgICAgICAgbG9nICJmYWlsZWQgdG8gcmV2ZXJ0IHRvICR7cHJldl92ZXJ9IHdpdGggJHtyZXR9IC0gZXhpdCIKICAgICAgICAgICAgZXhpdCAxCiAgICAgICAgZmkKCiAgICAgICAgbG9nICJyZXZlcnRpbmcgdG8gcHJldmlvdXMgdmVyc2lvbiAke3ByZXZfdmVyfSAtIHJlc3RhcnRpbmcgYWdlbnQgLi4uIgoKICAgICAgICAjIFRoZXJlIGlzIGEgZmxvdywgd2hlcmUgImhhbmRsZV91cGdyYWRlX2ZhaWx1cmUgcmV2ZXJ0IiBpcyBjYWxsZWQgb24gZmFpbHVyZSBvZgogICAgICAgICMgdGhlICJhcHQtZ2V0IGluc3RhbGwgPG5ldy12ZXJzaW9uPiIsIGJ1dCB0aGUgcHJldmlvdXMgdmVyc2lvbiB3YXMgbm90IHVuaW5zdGFsbGVkCiAgICAgICAgIyBhbmQgc3RpbGwgcnVucy4gSW4gdGhpcyBjYXNlIHRoZSAiYXB0LWdldCBpbnN0YWxsIDxwcmV2LXZlcnNpb24+IgogICAgICAgICMgd2lsbCBkbyBub3RoaW5nIGFuZCB3aWxsIHJldHVybiBPSyAoemVybykuIEFzIGEgcmVzdWx0LCB0aGUgImlmIiBibG9jayBhYm92ZSB3aWxsCiAgICAgICAgIyBiZSBub3QgZXhlY3V0ZWQgYW5kIHNlcnZpY2Ugd2lsbCBiZSBub3QgcmVzdGFydGVkLiBJbiB0aGlzIGNhc2UsIHRoZSBhZ2VudCB3aWxsIG5vdAogICAgICAgICMgY29ubmVjdCB0byB0aGUgZmxleGlNYW5hZ2UgYWZ0ZXIgcmV2ZXJ0LCBhcyB0aGlzIHNjcmlwdCBzdG9wcyB0aGUgY29ubmVjdGlvbiBsb29wCiAgICAgICAgIyB0aGUgYmVmb3JlIHVwZ2FyZGUsIGFuZCBub2JvZHkgc3RhcnRzIGl0IGJhY2suIFRvIGhhbmRsZSB0aGlzIGNhc2Ugd2UganVzdCByZXN0YXJ0CiAgICAgICAgIyBzZXJ2aWNlIGhlcmUsIHNvIHRoZSBjb25uZWN0aW9uIGxvb3Agc2hvdWxkIGJlIHJlc3VtZWQuCiAgICAgICAgIwogICAgICAgIHN5c3RlbWN0bCByZXN0YXJ0ICIkQUdFTlRfU0VSVklDRSIKCiAgICAgICAgbG9nICJyZXZlcnRpbmcgdG8gcHJldmlvdXMgdmVyc2lvbiAke3ByZXZfdmVyfSAtIGZpbmlzaGVkIgogICAgICAgIGV4aXQgMQogICAgZmkKCiAgICAjIENyZWF0ZSBhIGZpbGUgdGhhdCBtYXJrcyB0aGUgaW5zdGFsbGF0aW9uIGhhcyBmYWlsZWQKICAgIHRvdWNoICIkVVBHUkFERV9GQUlMVVJFX0ZJTEUiCgogICAgIyBSZWNvbm5lY3QgdG8gTUdNVAogICAgcmVzPSQoZndhZ2VudCBzdGFydCkKICAgIGlmIFsgJHtQSVBFU1RBVFVTWzBdfSAhPSAwIF07IHRoZW4KICAgICAgICBsb2cgJHJlcwogICAgICAgIGxvZyAiRmFpbGVkIHRvIHRvIGNvbm5lY3QgdG8gbWFuYWdlbWVudCIKICAgIGZpCiAgICBleGl0IDEKfQoKZ2V0X3ByZXZfdmVyc2lvbigpIHsKICAgIGlmIFsgISAtZiAiJFZFUlNJT05TX0ZJTEUiIF07IHRoZW4KICAgICAgICBsb2cgIkRldmljZSB2ZXJzaW9uIGZpbGUgJHtWRVJTSU9OU19GSUxFfSBub3QgZm91bmQiCiAgICAgICAgcmV0dXJuIDEKICAgIGZpCgogICAgdmVyX2VudHJ5PWBncmVwIGRldmljZSAiJFZFUlNJT05TX0ZJTEUiYAogICAgaWYgWyAteiAiJHZlcl9lbnRyeSIgXTsgdGhlbgogICAgICAgIGxvZyAiRGV2aWNlIHZlcnNpb24gbm90IGZvdW5kIGluICR7VkVSU0lPTlNfRklMRX0iCiAgICAgICAgcmV0dXJuIDEKICAgIGZpCgogICAgcHJldl92ZXI9YGVjaG8gIiR2ZXJfZW50cnkiIHwgYXdrICd7c3BsaXQoJDAsIHJlcywgIiAiKTsgcHJpbnQgcmVzWzJdfSdgCn0KCnVwZGF0ZV9zZXJ2aWNlX2NvbmZfZmlsZSgpIHsKICAgIGlmIFsgISAtZiAiJEFHRU5UX1NFUlZJQ0VfRklMRSIgXTsgdGhlbgogICAgICAgIGxvZyAiU2VydmljZSBjb25maWd1cmF0aW9uIGZpbGUgJHtBR0VOVF9TRVJWSUNFX0ZJTEV9IG5vdCBmb3VuZCIKICAgICAgICByZXR1cm4gMQogICAgZmkKCiAgICAjIERvbid0IGFkZCB0aGUgY29uZmlndXJhdGlvbiBpZiBpdCBhbHJlYWR5IGV4aXN0cwogICAga2lsbF9tb2RlX2NvbmY9YGdyZXAgS2lsbE1vZGU9cHJvY2VzcyAiJEFHRU5UX1NFUlZJQ0VfRklMRSJgCiAgICBpZiBbIC16ICIka2lsbF9tb2RlX2NvbmYiIF07IHRoZW4KICAgICAgICBlY2hvIC1lICJcbltTZXJ2aWNlXVxuS2lsbE1vZGU9cHJvY2VzcyIgPj4gIiRBR0VOVF9TRVJWSUNFX0ZJTEUiCiAgICAgICAgc3lzdGVtY3RsIGRhZW1vbi1yZWxvYWQKICAgIGZpCn0KCmNoZWNrX2Nvbm5lY3Rpb25fdG9fc3dfcmVwbygpIHsKICAgIHBpbmcgLWMgMSBkZWIuZmxleGl3YW4uY29tID4+IC9kZXYvbnVsbCAyPiYxCiAgICBpZiBbICR7UElQRVNUQVRVU1swXX0gIT0gMCBdOyB0aGVuCiAgICAgICAgcmV0dXJuIDEKICAgIGZpCiAgICByZXR1cm4gMAp9CgphcHRfaW5zdGFsbCgpIHsKCiAgICAjIFNldCAiS2lsbE1vZGUiIG9wdGlvbiBpbiB0aGUgc2VydmljZSBmaWxlLCB0byBtYWtlIHN1cmUgc3lzdGVtZAogICAgIyBkb2Vzbid0IGtpbGwgdGhlICdmd3VwZ3JhZGUuc2gnIHByb2Nlc3MgaXRzZWxmIG9uIHN0b3BwaW5nIHRoZSBmd2FnZW50IHByb2Nlc3MsCiAgICAjIGFzIHRvZGF5IHRoZSAnZnd1cGdyYWRlLnNoJyBpcyBpbnZva2VkIGJ5IHRoZSBmd2FnZW50IG9uIHJlY2VpdmluZwogICAgIyAndXBncmFkZS1kZXZpY2Utc3cnIHJlcXVlc3QgZnJvbSBmbGV4aU1hbmFnZS4gTm90ZSwgdGhlIHZwcCBhbmQgcmVzdCBwcm9jZXNzZXMKICAgICMgaW4gdGhlIGZ3YWdlbnQgY29udHJvbCBncm91cCBhcmUgbm90IHN0b3BwZWQgdG9vLCBidXQgd2UgYXJlIE9LIHdpdGggdGhpcyBmb3Igbm93LgogICAgIwogICAgdXBkYXRlX3NlcnZpY2VfY29uZl9maWxlCiAgICByZXQ9JHtQSVBFU1RBVFVTWzBdfQogICAgaWYgWyAke3JldH0gIT0gMCBdOyB0aGVuCiAgICAgICAgbG9nICJhcHRfaW5zdGFsbDogdXBkYXRlX3NlcnZpY2VfY29uZl9maWxlIGZhaWxlZDogJHtyZXR9IgogICAgICAgIHJldHVybiAxCiAgICBmaQoKICAgIHJlcz0kKGFwdC1nZXQgLW8gRHBrZzo6T3B0aW9uczo6PSItLWZvcmNlLWNvbmZvbGQiIC15IGluc3RhbGwgLS1hbGxvdy1kb3duZ3JhZGVzICQxKQogICAgcmV0PSR7UElQRVNUQVRVU1swXX0KICAgIGlmIFsgJHtyZXR9ICE9IDAgXTsgdGhlbgogICAgICAgIGxvZyAiYXB0X2luc3RhbGw6ICQxIGZhaWxlZDogJHtyZXR9OiAke3Jlc30iCiAgICAgICAgcmV0dXJuIDIKICAgIGZpCiAgICByZXR1cm4gMAp9CgojIFVwZ3JhZGUgcHJvY2Vzcwpsb2cgIlN0YXJ0aW5nIHNvZnR3YXJlIHVwZ3JhZGUgcHJvY2Vzcy4uLiIKCiMgUmVtb3ZlIHRoZSBmaWxlIHRoYXQgcmVwcmVzZW50cyB1cGdyYWRlIGZhaWx1cmUuIFRoaXMgZmlsZQojIGlzIGNyZWF0ZWQgYnkgZWl0aGVyIHRoaXMgc2NyaXB0IChpZiB0aGUgZmFpbHVyZSBpcyBkdXJpbmcgdGhlCiMgc29mdHdhcmUgdXBncmFkZSBwcm9jZXNzKSwgb3IgYnkgdGhlIGFnZW50LCBpZiBwb3N0LWluc3RhbGxhdGlvbgojIGNoZWNrcyBmYWlsCnJtICIkVVBHUkFERV9GQUlMVVJFX0ZJTEUiID4+IC9kZXYvbnVsbCAyPiYxCgojIFNhdmUgcHJldmlvdXMgdmVyc2lvbiBmb3IgcmV2ZXJ0IGluIGNhc2UgdGhlIHVwZ3JhZGUgcHJvY2VzcyBmYWlscwpnZXRfcHJldl92ZXJzaW9uCmlmIFsgLXogIiRwcmV2X3ZlciIgXTsgdGhlbgogICAgbG9nICJGYWlsZWQgdG8gZXh0cmFjdCBwcmV2aW91cyB2ZXJzaW9uIGZyb20gJHtWRVJTSU9OU19GSUxFfSIKICAgIGhhbmRsZV91cGdyYWRlX2ZhaWx1cmUKZmkKCiMgUXVpdCB1cGdyYWRlIHByb2Nlc3MgaWYgZGV2aWNlIGlzIGFscmVhZHkgcnVubmluZyB0aGUgbGF0ZXN0IHZlcnNpb24KZHBrZyAtLWNvbXBhcmUtdmVyc2lvbnMgIiRUQVJHRVRfVkVSU0lPTiIgbGUgIiRwcmV2X3ZlciIKaWYgWyAkPyA9PSAwIF07IHRoZW4KICAgIGxvZyAiRGV2aWNlIGFscmVhZHkgcnVubmluZyBsYXRlc3QgdmVyc2lvbi4gUXVpdGluZyB1cGdyYWRlIHByb2Nlc3MiCiAgICBleGl0IDAKZmkKCiMgU3RvcCBhZ2VudCBjb25uZWN0aW9uIGxvb3AgdG8gdGhlIE1HTVQsIHRvIG1ha2Ugc3VyZSB0aGUKIyBhZ2VudCBkb2VzIG5vdCBwcmNvZXNzIG1lc3NhZ2VzIGR1cmluZyB0aGUgdXBncmFkZSBwcm9jZXNzLgpsb2cgIkNsb3NpbmcgY29ubmVjdGlvbiB0byBNR01ULi4uIgpyZXM9JChmd2FnZW50IHN0b3AgLXIpCmlmIFsgJHtQSVBFU1RBVFVTWzBdfSAhPSAwIF07IHRoZW4KICAgIGxvZyAkcmVzCiAgICBsb2cgIkZhaWxlZCB0byBzdG9wIGFnZW50IGNvbm5lY3Rpb24gdG8gbWFuYWdlbWVudCIKICAgIGhhbmRsZV91cGdyYWRlX2ZhaWx1cmUKZmkKCmxvZyAiSW5zdGFsbGluZyBuZXcgc29mdHdhcmUuLi4iCgojIENoZWNrIGNvbm5lY3Rpb24gdG8gdGhlIHNvZnR3YXJlIHBhY2thZ2UgcmVwb3NpdG9yeS4KIyBXZSBoYXZlIHRvIGNoZWNrIGV4Y3BsaWNpdGx5IHNpbmNlIHRoZSAnYXB0LWdldCB1cGRhdGUnCiMgY29tbWFuZCByZXR1cm5zIHN1Y2Nlc3Mgc3RhdHVzIGNvZGUgZXZlbiBpZiB0aGUgY29ubmVjdGlvbiBmYWlscy4KY2hlY2tfY29ubmVjdGlvbl90b19zd19yZXBvCmlmIFsgJHtQSVBFU1RBVFVTWzBdfSAhPSAwIF07IHRoZW4KICAgIGxvZyAiRmFpbGVkIHRvIGNvbm5lY3QgdG8gc29mdHdhcmUgcmVwb3NpdG9yeSAke1NXX1JFUE9TSVRPUll9IgogICAgaGFuZGxlX3VwZ3JhZGVfZmFpbHVyZQpmaQoKIyBVcGRhdGUgZGViaWFuIHJlcG9zaXRvcmllcwpyZXM9JChhcHQtZ2V0IHVwZGF0ZSkKaWYgWyAke1BJUEVTVEFUVVNbMF19ICE9IDAgXTsgdGhlbgogICAgbG9nICRyZXMKICAgIGxvZyAiRmFpbGVkIHRvIHVwZGF0ZSBkZWJpYW4gcmVwb3NpdG9yZXMiCiAgICBoYW5kbGVfdXBncmFkZV9mYWlsdXJlCmZpCgojIFVwZ3JhZGUgZGV2aWNlIHBhY2thZ2UuIEZyb20gdGhpcyBzdGFnZSBvbiwgd2Ugc2hvdWxkCiMgcGFzcyAncmV2ZXJ0JyB0byBoYW5kbGVfdXBncmFkZV9mYWlsdXJlKCkgdXBvbiBmYWlsdXJlCiMKYXB0X2luc3RhbGwgIiR7QUdFTlRfU0VSVklDRX0iCnJldD0ke1BJUEVTVEFUVVNbMF19CmlmIFsgJHtyZXR9ID09IDEgXTsgdGhlbgogICAgbG9nICJmYWlsZWQgdG8gaW5zdGFsbCBsYXRlc3QgdmVyc2lvbiAocmV0PSR7cmV0fSkiCiAgICBoYW5kbGVfdXBncmFkZV9mYWlsdXJlCmVsaWYgWyAke3JldH0gPT0gMiBdOyB0aGVuCiAgICBsb2cgImZhaWxlZCB0byBpbnN0YWxsIGxhdGVzdCB2ZXJzaW9uIChyZXQ9JHtyZXR9KSIKICAgIGhhbmRsZV91cGdyYWRlX2ZhaWx1cmUgInJldmVydCIKZmkKCiMgUmVvcGVuIHRoZSBjb25uZWN0aW9uIGxvb3AgaW4gY2FzZSBpdCBpcyBjbG9zZWQKcmVzPSQoZndhZ2VudCBzdGFydCkKaWYgWyAke1BJUEVTVEFUVVNbMF19ICE9IDAgXTsgdGhlbgogICAgbG9nICRyZXMKICAgIGxvZyAiRmFpbGVkIHRvIHRvIHJlY29ubmVjdCB0byBtYW5hZ2VtZW50IgpmaQoKIyBXYWl0IHRvIHNlZSBpZiBzZXJ2aWNlIGlzIHVwIGFuZCBjb25uZWN0ZWQgdG8gdGhlIE1HTVQKbG9nICJGaW5pc2hlZCBpbnN0YWxsaW5nIG5ldyBzb2Z0d2FyZS4gd2FpdGluZyBmb3IgYWdlbnQgY2hlY2sgKCR7QUdFTlRfQ0hFQ0tfVElNRU9VVH0gc2VjKSIKc2xlZXAgIiRBR0VOVF9DSEVDS19USU1FT1VUIgoKaWYgWyAtZiAiJFVQR1JBREVfRkFJTFVSRV9GSUxFIiBdOyB0aGVuCiAgICBsb2cgIkFnZW50IGNoZWNrcyBmYWlsZWQiCiAgICBoYW5kbGVfdXBncmFkZV9mYWlsdXJlICdyZXZlcnQnCmZpCgpsb2cgIlNvZnR3YXJlIHVwZ3JhZGUgcHJvY2VzcyBmaW5pc2hlZCBzdWNjZXNzZnVsbHkiCmV4aXQgMAoK | base64 -d > /usr/share/flexiwan/agent/fwupgrade.sh',
  // eslint-disable-next-line max-len
  6.2: 'apt install -y ca-certificates;sed -i \'/if \\[ -f "$UPGRADE_FAILURE_FILE" \\]; then/iif grep -qe "^success$" "$UPGRADE_FAILURE_FILE"; then rm "$UPGRADE_FAILURE_FILE"; fi\' /usr/share/flexiwan/agent/fwupgrade.sh'
};

const NOTIFICATIONS_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Queues upgrade jobs to a list of devices.
 * @param  {Array}   devices       array of devices to which an upgrade job should be queued
 * @param  {string}  user          user name of the user the queued the job
 * @param  {string}  org           id of the organization to which the user belongs
 * @param  {string}  targetVersion the version to which the device will be upgraded
 * @return {Promise}               a promise for queuing an upgrade job
 */
const queueUpgradeJobs = (devices, user, org, targetVersion) => {
  // Generate the per version pre upgrade job
  const majorMinor = `${getMajorVersion(targetVersion)}.${getMinorVersion(targetVersion)}`;
  let preUpdateTasks = '';
  if (perVersionJobs.hasOwnProperty(majorMinor)) {
    preUpdateTasks = [{
      entity: 'agent',
      message: 'exec_timeout',
      params: {
        cmd: perVersionJobs[majorMinor],
        timeout: 60
      }
    }];
  }
  const tasks = [{
    entity: 'agent',
    message: 'upgrade-device-sw',
    params: { version: targetVersion }
  }];
  const jobs = [];
  devices.forEach(dev => {
    deviceStatus.setDeviceState(dev.machineId, 'pending');
    if (preUpdateTasks) {
      jobs.push(
        deviceQueues.addJob(dev.machineId, user, org,
        // Data
          { title: `Pre Upgrade Tasks ${dev.hostname}`, tasks: preUpdateTasks },
          // Response data
          {},
          // Metadata
          { priority: 'normal', attempts: 1, removeOnComplete: false },
          // Complete callback
          null)
      );
    }
    jobs.push(
      deviceQueues.addJob(dev.machineId, user, org,
        // Data
        { title: `Upgrade device ${dev.hostname}`, tasks: tasks },
        // Response data
        { method: 'upgrade', data: { device: dev._id, org: org } },
        // Metadata
        { priority: 'normal', attempts: 1, removeOnComplete: false },
        // Complete callback
        null)
    );
  });

  return Promise.all(jobs);
};

/**
 * Queues OS upgrade jobs to a list of devices.
 * @param  {Array}   devices       array of devices to which an upgrade job should be queued
 * @param  {string}  user          user name of the user the queued the job
 * @param  {string}  org           id of the organization to which the user belongs
 * @return {Promise}               a promise for queuing an upgrade job
 */
const queueOsUpgradeJobs = (devices, user, orgId, reasons) => {
  const tasks = [{
    entity: 'agent',
    message: 'upgrade-linux-sw',
    params: { 'upgrade-from': 'bionic' }
  }];
  const jobs = [];
  devices.forEach(dev => {
    // Only queue job if device version > 6.2.X
    const majorVersion = getMajorVersion(dev.versions.device);
    const minorVersion = getMinorVersion(dev.versions.device);
    if (majorVersion > 6 || (majorVersion === 6 && minorVersion >= 2)) {
      deviceStatus.setDeviceState(dev.machineId, 'pending');
      jobs.push(
        deviceQueues.addJob(dev.machineId, user, orgId,
        // Data
          { title: `Upgrade OS for device ${dev.name}`, tasks: tasks },
          // Response data
          { method: 'osupgrade', data: { device: dev._id, org: orgId } },
          // Metadata
          { priority: 'normal', attempts: 1, removeOnComplete: false },
          // Complete callback
          null)
      );
    } else {
      reasons.add('Devices with version lower than 6.2.X cannot be upgraded');
      logger.info('OS upgrade device job skipped for device', {
        params: { machineId: dev.machineId, version: dev.versions.device }
      });
    }
  });
  return jobs;
};

/**
 * Applies the upgrade request on all requested devices
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const apply = async (opDevices, user, data) => {
  // opDevices is a filtered array of selected devices (mongoose objects)

  const swUpdater = DevSwUpdater.getSwVerUpdaterInstance();
  const version = await swUpdater.getLatestDevSwVersion();
  const userName = user.username;
  const org = data.org;
  const jobResults = await queueUpgradeJobs(opDevices, userName, org, version);
  // disable email & resolved notifications (will be enabled automatically using a timer)
  disableOrEnableNotificationsAfterUpgrade(org);
  jobResults.forEach(job => {
    logger.info('Upgrade device job queued', {
      params: { jobId: job.id, version: version },
      job: job
    });
  });

  // Set the upgrade job pending flag for all devices.
  // This prevents queuing additional periodic upgrade tasks as long
  // as there's a pending upgrade task in a device's queue.
  const deviceIDs = opDevices.map(dev => { return dev._id; });
  await setQueuedUpgradeFlag(deviceIDs, org, true);
  return { ids: jobResults.map(job => job.id), status: 'completed', message: '' };
};

/**
 * Retrieves the current notification settings for a specific organization.
 * @async
 * @param {String} org - Identifier of the organization.
 * @return {Object|null} The current notification settings or null if an error occurs.
 */
const getNotificationSettings = async (org) => {
  try {
    return await notificationsConf.findOne({ org });
  } catch (error) {
    logger.error(`Error retrieving notifications settings: ${error}`);
    return null;
  }
};

/**
 * Updates update-device related notification settings for a given organization.
 * If disabling, sets all notifications to false. If enabling, restores to their original state.
 * @async
 * @param {Boolean} shouldDisable - Indicates whether to disable or enable) notifications.
 * @param {String} org - Identifier of the organization.
 * @param {Object|null} originalSettings - Original notification settings, used for restoring.
 * @return {Object|null} The updated notification settings or null if an error occurs.
 */
const updateNotifications = async (shouldDisable, org, originalSettings = null) => {
  const conditions = { org };

  let update;
  if (shouldDisable) {
    update = {
      $set: {
        'rules.Running router.immediateEmail': false,
        'rules.Running router.resolvedAlert': false,
        'rules.Tunnel connection.immediateEmail': false,
        'rules.Tunnel connection.resolvedAlert': false,
        'rules.Device connection.immediateEmail': false,
        'rules.Device connection.resolvedAlert': false
      }
    };
  } else {
    // Re-enable only the ones that were originally true
    update = { $set: {} };
    const notificationTypes = ['Running router', 'Tunnel connection', 'Device connection'];
    const notificationRuleTypes = ['immediateEmail', 'resolvedAlert'];

    notificationTypes.forEach(notificationType => {
      notificationRuleTypes.forEach(ruleType => {
        const rulePath = `rules.${notificationType}.${ruleType}`;
        if (originalSettings && originalSettings.rules[notificationType] &&
          originalSettings.rules[notificationType][ruleType] === true) {
          update.$set[rulePath] = true;
        }
      });
    });
  }

  try {
    return await notificationsConf.findOneAndUpdate(conditions, update, { new: true });
  } catch (error) {
    logger.error(`Error updating notifications settings: ${error}`);
    return null;
  }
};

/**
 * Disables and then re-enables the email notifications and resolved notifications
 * for an organization while upgrading devices versions.
 * Disabling sets all notifications to false, and re-enabling restores them to their original state.
 * @async
 * @param {String} org - Identifier of the organization.
 * @return {Object|null} The result of the disable operation or null if an error occurs.
 */
const disableOrEnableNotificationsAfterUpgrade = async (org) => {
  const originalSettings = await getNotificationSettings(org);
  const disableResult = await updateNotifications(true, org);

  if (disableResult) {
    logger.info(
      'Email & resolved Notifications disabled due to an update, re-enabling after 5 mins');
    setTimeout(async () => {
      await updateNotifications(false, org, originalSettings);
      logger.info('Notifications re-enabled');
    }, NOTIFICATIONS_TIMEOUT);
  }

  return disableResult;
};

/**
 * Applies the OS upgrade request on all requested devices
 * @async
 * @param  {Array}    device    an array of the devices to be modified
 * @param  {Object}   user      User object
 * @param  {Object}   data      Additional data used by caller
 * @return {None}
 */
const osUpgradeApply = async (opDevices, user, data) => {
  // opDevices is a filtered array of selected devices (mongoose objects)
  const userName = user.username;
  const org = data.org;
  const reasons = new Set(); // unique messages array for errors
  const jobTasks = await queueOsUpgradeJobs(opDevices, userName, org, reasons);

  const promiseStatus = await Promise.allSettled(jobTasks);
  const fulfilled = promiseStatus.reduce((arr, elem) => {
    if (elem.status === 'fulfilled') {
      const job = elem.value;
      arr.push(job);
    }
    return arr;
  }, []);

  const status = fulfilled.length < jobTasks.length
    ? 'partially completed' : 'completed';

  const desired = jobTasks.flat().map(job => job.id);
  const ids = fulfilled.flat().map(job => job.id);
  let message = 'Host OS upgrade jobs added.';
  if (desired.length === 0 || fulfilled.flat().length === 0) {
    message = 'No ' + message;
  } else if (ids.length < opDevices.length) {
    message = `${ids.length} of ${opDevices.length} ${message}`;
  } else {
    message = `${ids.length} ${message}`;
  }
  if (reasons.size > 0) {
    message = `${message} ${Array.from(reasons).join(' ')}`;
  }
  return { ids, status, message };
};

/**
 * Sets the value of the pending upgrade flag in the database.
 * The pending upgrade flag indicates if a pending upgrade job
 * already exists in the device's queue.
 * @param  {string}  deviceID the id of the device
 * @param  {string}  org      the id of the organization the device belongs to
 * @param  {boolean} flag     the value to be set in the database
 * @return {Promise}
 */
const setQueuedUpgradeFlag = (deviceID, org, flag) => {
  return devices.updateMany(
    { _id: { $in: deviceID }, org: org },
    { $set: { 'upgradeSchedule.jobQueued': flag } },
    { upsert: false }
  );
};

/**
 * Called when upgrade device job completes to unset
 * the pending upgrade job flag in the database.
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {string} res   device object ID and username
 * @return {void}
 */
const complete = async (jobId, res) => {
  try {
    await setQueuedUpgradeFlag([res.device], res.org, false);
  } catch (err) {
    logger.warn('Failed to update jobQueued field in database', {
      params: { result: res, jobId: jobId }
    });
  }
};

/**
 * Called when OS upgrade device job completes
 * @async
 * @param  {number} jobId Kue job ID number
 * @param  {string} res   device object ID and username
 * @return {void}
 */
const osUpgradeComplete = async (jobId, res) => {
};

/**
 * Called if upgrade device job fails to unset
 * the pending upgrade job flag in the database.
 * @async
 * @param  {number} jobId Kue job ID
 * @param  {Object} res
 * @return {void}
 */
const error = async (jobId, res) => {
  logger.warn('Device Upgrade failed', { params: { result: res, jobId: jobId } });
  try {
    await setQueuedUpgradeFlag([res.device], res.org, false);
  } catch (err) {
    logger.warn('Failed to update jobQueued field in database', {
      params: { result: res, jobId: jobId }
    });
  }
};

/**
 * Called if upgrade device job was removed to unset
 * the pending upgrade job flag in the database.
 * @async
 * @param  {number} jobId Kue job ID
 * @param  {Object} res
 * @return {void}
 */
const remove = async (job) => {
  if (['inactive', 'delayed', 'active'].includes(job._state)) {
    logger.info('Device Upgrade job removed', { params: { job: job } });
    try {
      const { org, device } = job.data.response.data;
      await setQueuedUpgradeFlag([device], org, false);
    } catch (err) {
      logger.error('Failed to update jobQueued field in database', {
        params: { job: job, err: err.message }
      });
    }
  }
};

module.exports = {
  apply: apply,
  osUpgradeApply: osUpgradeApply,
  complete: complete,
  osUpgradeComplete: osUpgradeComplete,
  queueUpgradeJobs: queueUpgradeJobs,
  error: error,
  remove: remove
};

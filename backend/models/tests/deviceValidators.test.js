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

const validators = require('../validators');

describe('validateDeviceName', () => {
  const tooLongDeviceName = 'a device name with more than fifty characters is not allowed';
  const maxDeviceName = 'maximal___device___name___is___fifty___characters_';

  it.each`
        name                    | result
        ${'device1'}            | ${true}
        ${'device-1'}           | ${true}
        ${'device_1'}           | ${true}
        ${'Device 1'}           | ${true}
        ${'Device.1'}           | ${true}
        ${'__dev__'}            | ${true}
        ${'local_dev_1'}        | ${true}
        ${'__local_dev'}        | ${true}
        ${'DEVICE-1'}           | ${true}
        ${'!@#%()[]:'}          | ${true}
        ${maxDeviceName}        | ${true}
        ${''}                   | ${true}
        ${'$^&*{}'}             | ${false}
        ${tooLongDeviceName}    | ${false}
        ${null}                 | ${false}
        ${undefined}            | ${false}
  `('Should return $result if device name is $name', ({ name, result }) => {
    expect(validators.validateDeviceName(name)).toEqual(result);
  });
});

describe('validateDescription', () => {
  const tooLongDescription = 'A device description should not contain more than fifty characters';
  const maxDescriptionLength = 'A device description can be up to fifty characters';
  it.each`
        desc                        | result
        ${'this is a device'}       | ${true}
        ${'THIS IS A DEVICE'}       | ${true}
        ${'Device number 1'}        | ${true}
        ${'Device number 1.'}       | ${true}
        ${'Device_description'}     | ${true}
        ${'Device-description'}     | ${true}
        ${'!@#%()[]:'}              | ${true}
        ${maxDescriptionLength}     | ${true}
        ${''}                       | ${true}
        ${'$^&*{}'}                 | ${false}
        ${tooLongDescription}       | ${false}
        ${null}                     | ${false}
        ${undefined}                | ${false}
  `('Should return $result if device description is $desc', ({ desc, result }) => {
    expect(validators.validateDescription(desc)).toEqual(result);
  });
});

describe('validateDeviceSite', () => {
  const tooLongSiteName = 'A device site name should not contain more than fifty characters';
  const maxSiteNameLength = 'A device site can be up to fifty characters long  ';
  it.each`
        site                        | result
        ${'London'}                 | ${true}
        ${'Madrid center'}          | ${true}
        ${'Broadway st. 15'}        | ${true}
        ${'Berlin_office'}          | ${true}
        ${'New-York_office'}        | ${true}
        ${'Office@New-York'}        | ${true}
        ${'!@#%()[]:'}              | ${true}
        ${maxSiteNameLength}        | ${true}
        ${''}                       | ${true}
        ${'$^&*{}'}                 | ${false}
        ${tooLongSiteName}          | ${false}
        ${null}                     | ${false}
        ${undefined}                | ${false}
  `('Should return $result if device site name is $site', ({ site, result }) => {
    expect(validators.validateDeviceSite(site)).toEqual(result);
  });
});

describe('validateHostName', () => {
  const tooLongHostname = Array.from({ length: 254 }, () => { return 'a'; }).join('');
  const maxHostnameLent = Array.from({ length: 253 }, () => { return 'a'; }).join('');
  it.each`
        host                        | result
        ${'hostname'}               | ${true}
        ${'HOSTNAME'}               | ${true}
        ${'hostname.subName'}       | ${true}
        ${'host-name'}              | ${true}
        ${maxHostnameLent}          | ${true}
        ${''}                       | ${false}
        ${'host@name'}              | ${false}
        ${'host_name'}              | ${true}
        ${'$%^&*()'}                | ${false}
        ${tooLongHostname}          | ${false}
        ${null}                     | ${false}
        ${undefined}                | ${false}
  `('Should return $result if device hostname is $host', ({ host, result }) => {
    expect(validators.validateHostName(host)).toEqual(result);
  });
});

describe('validateIpList', () => {
  it.each`
        list                                            | result
        ${'192.168.1.1, 192.168.1.2, 192.168.1.3'}      | ${true}
        ${'192.168.1.1,192.168.1.2,192.168.1.3'}        | ${true}
        ${'192.168.1.1,   192.168.1.2'}                 | ${true}
        ${''}                                           | ${true}
        ${null}                                         | ${false}
        ${undefined}                                    | ${false}
        ${'192.168.1.1 192.168.1.2'}                    | ${false}
        ${'10.0.0.1@10.0.0.2'}                          | ${false}
  `('Should return $result if device IP list is $list', ({ list, result }) => {
    expect(validators.validateIpList(list)).toEqual(result);
  });
});

describe('validateMachineID', () => {
  const tooLongMachineID = 'C9B35F0D-DF7C-43D5-8F8F-C2C576FEBAF7-C9B35F0D-DF7C-43D5';
  const maxMachineID = 'C9B35F0D-C9B35F0D-C9B35F0D-C9B35F0D-C9B35F0D-C9B35';
  it.each`
        id                                              | result
        ${'C9B35F0D-DF7C-43D5-8F8F-C2C576FEBAF7'}       | ${true}
        ${'C9B35F0D'}                                   | ${true}
        ${'c9b35f0d'}                                   | ${true}
        ${maxMachineID}                                 | ${true}
        ${''}                                           | ${false}
        ${null}                                         | ${false}
        ${undefined}                                    | ${false}
        ${tooLongMachineID}                             | ${false}
        ${'N9B35T0Z'}                                   | ${false}
        ${'C9B3.F0D'}                                   | ${false}
        ${'C9B3_F0D'}                                   | ${false}
  `('Should return $result if machine ID is $id', ({ id, result }) => {
    expect(validators.validateMachineID(id)).toEqual(result);
  });
});

describe('validateSerial', () => {
  const tooLongSerial = 'ABCDEFGHI-123456789-JKLMNOPQR-012345678-STUVWXYZ.#' +
  'ABCDEFGHI 123456789 JKLMNOPQR 012345678 STUVWXYZ%:' +
  'ABCDEFGHI_123456789_JKLMNOPQR_012345678_STUVWXYZ()' +
  'abcdefghi-123456789-jklmnopqr-012345678-stuvwxyz[]' +
  'ABCDEFGHI-123456789-JKLMNOPQR-012345678-STUVWXYZ/#01';

  const maxSerial = 'ABCDEFGHI-123456789-JKLMNOPQR-012345678-STUVWXYZ.#' +
  'ABCDEFGHI 123456789 JKLMNOPQR 012345678 STUVWXYZ%:' +
  'ABCDEFGHI_123456789_JKLMNOPQR_012345678_STUVWXYZ()' +
  'ABCDEFGHI-123456789-JKLMNOPQR-012345678-STUVWXYZ[]' +
  'ABCDEFGHI-123456789-JKLMNOPQR-012345678-STUVWXYZ/#';
  it.each`
        id                                              | result
        ${'C9B35F0D-DF7C-43D5-8F8F-C2C576FEBAF7'}       | ${true}
        ${''}                                           | ${true}
        ${'S/N-12#45%RD'}                               | ${true}
        ${'(0123:ERF789:abz)'}                          | ${true}
        ${'[0123:ERF789:eft]'}                          | ${true}
        ${maxSerial}                                    | ${true}
        ${''}                                           | ${true}
        ${null}                                         | ${false}
        ${undefined}                                    | ${false}
        ${tooLongSerial}                                | ${false}
        ${'N9B@T0Z'}                                    | ${false}
        ${'C9B3>F0D'}                                   | ${false}
        ${'C9B3!F0D'}                                   | ${false}
        ${'C9B3<F0D'}                                   | ${false}
  `('Should return $result if serial is $id', ({ id, result }) => {
    expect(validators.validateSerial(id)).toEqual(result);
  });
});

describe('validateTokenName', () => {
  const tooLongTokenName = 'token-name-longer-than-15';
  const maxTokenName = '15-chars-token-';
  it.each`
        name                    | result
        ${'Token'}              | ${true}
        ${'A-token'}            | ${true}
        ${'token_1'}            | ${true}
        ${'token-1'}            | ${true}
        ${'token A'}            | ${true}
        ${'token.1'}            | ${true}
        ${'!@#%()[]:'}          | ${true}
        ${maxTokenName}         | ${true}
        ${tooLongTokenName}     | ${false}
        ${''}                   | ${false}
        ${null}                 | ${false}
        ${undefined}            | ${false}
  `('Should return $result if token name is $name', ({ name, result }) => {
    expect(validators.validateTokenName(name)).toEqual(result);
  });
});

describe('validateIPv4', () => {
  it.each`
        addr                    | result
        ${'192.168.100.1'}      | ${true}
        ${''}                   | ${true}
        ${'::0001'}             | ${false}
        ${'192.168.1'}          | ${false}
        ${1}                    | ${false}
        ${null}                 | ${false}
        ${undefined}            | ${false}
  `('Should return $result if IPv4 address is $addr', ({ addr, result }) => {
    expect(validators.validateIPv4(addr)).toEqual(result);
  });
});

describe('validateIPv4Mask', () => {
  it.each`
        mask                    | result
        ${'0'}                  | ${true}
        ${'24'}                 | ${true}
        ${'32'}                 | ${true}
        ${''}                   | ${true}
        ${'-1'}                 | ${false}
        ${'100'}                | ${false}
        ${null}                 | ${false}
        ${undefined}            | ${false}
  `('Should return $result if IPv4 mask is $mask', ({ mask, result }) => {
    expect(validators.validateIPv4Mask(mask)).toEqual(result);
  });
});

describe('validateIPv6', () => {
  it.each`
        addr                    | result
        ${'::0001'}             | ${true}
        ${'ff02::0001'}         | ${true}
        ${''}                   | ${true}
        ${'192.168.100.1'}      | ${false}
        ${'0:0'}                | ${false}
        ${1}                    | ${false}
        ${null}                 | ${false}
        ${undefined}            | ${false}
  `('Should return $result if IPv6 address is $addr', ({ addr, result }) => {
    expect(validators.validateIPv6(addr)).toEqual(result);
  });
});

describe('validateIPv6Mask', () => {
  it.each`
        mask                    | result
        ${'0'}                  | ${true}
        ${'24'}                 | ${true}
        ${'128'}                 | ${true}
        ${''}                   | ${true}
        ${'-1'}                 | ${false}
        ${'133'}                | ${false}
        ${null}                 | ${false}
        ${undefined}            | ${false}
  `('Should return $result if IPv6 mask is $mask', ({ mask, result }) => {
    expect(validators.validateIPv6Mask(mask)).toEqual(result);
  });
});

describe('validatePortRange', () => {
  it.each`
        range                   | result
        ${'0'}                  | ${true}
        ${'80'}                 | ${true}
        ${'80-8080'}            | ${true}
        ${'65535'}              | ${true}
        ${''}                   | ${true}
        ${'-1-23'}              | ${false}
        ${'-1'}                 | ${false}
        ${'65536'}              | ${false}
        ${'not-a-number'}       | ${false}
        ${null}                 | ${false}
        ${undefined}            | ${false}
  `('Should return $result if port range is $range', ({ range, result }) => {
    expect(validators.validatePortRange(range)).toEqual(result);
  });
});

// Basic BDF format: xx:yy.zz, all values are hexadecimal
describe('validatePCI basic BDF format', () => {
  it.each`
        pci                     | result
        ${'pci:00:02.00'}           | ${true}
        ${'pci:0000:02.00'}         | ${true}
        ${'00:02.00'}           | ${false}
        ${'pci:0:01.00'}            | ${false}
        ${'pci:000:01.00'}          | ${false}
        ${'pci:00:1.00'}            | ${false}
        ${'pci:00:.00'}             | ${false}
        ${'pci:00:00.1'}            | ${false}
        ${'pci:00:00.100'}          | ${false}
        ${'pci:TT:00.00'}           | ${false}
        ${'pci:00:00.PP'}           | ${false}
  `('Should return $result if pci address is $pci', ({ pci, result }) => {
    expect(validators.validatePciAddress(pci)).toEqual(result);
  });
});

describe('validateDHCP', () => {
  it.each`
        dhcp                    | result
        ${'yes'}                | ${true}
        ${'no'}                 | ${true}
        ${null}                 | ${false}
        ${undefined}            | ${false}
        ${''}                   | ${false}
  `('Should return $result if interface dhcp is $dhcp', ({ dhcp, result }) => {
    expect(validators.validateDHCP(dhcp)).toEqual(result);
  });
});

describe('validateIPaddr', () => {
  it.each`
        addr                    | result
        ${'::0001'}             | ${true}
        ${'192.168.100.1'}      | ${true}
  `('Should return $result if IP address is $addr', ({ addr, result }) => {
    expect(validators.validateIPaddr(addr)).toEqual(result);
  });
});

// Extended BDF format: ww:xx:yy.zz, all values are hexadecimal
describe('validatePCI extended BDF format', () => {
  it.each`
        pci                     | result
        ${'pci:0000:0000:00.12'}    | ${true}
        ${'pci:0000:00:03.00'}      | ${true}
        ${'pci:00:00:03.00'}        | ${true}
        ${'pci:0:00:03.00'}         | ${false}
        ${'pci:0:00:03.00'}         | ${false}
  `('Should return $result if pci address is $pci', ({ pci, result }) => {
    expect(validators.validatePciAddress(pci)).toEqual(result);
  });
});

// PCI address should be incase sensitive
describe('validatePCI case sensitivity', () => {
  it.each`
        pci                     | result
        ${'pci:00:00:ab.00'}        | ${true}
        ${'pci:00:00:AB.00'}        | ${true}
        ${'pci:00:00:Ab.00'}        | ${true}
  `('Should return $result if pci address is $pci', ({ pci, result }) => {
    expect(validators.validatePciAddress(pci)).toEqual(result);
  });
});

describe('validatePCI empty values', () => {
  it.each`
        pci                     | result
        ${''}                   | ${true}
        ${null}                 | ${false}
        ${undefined}            | ${false}
   `('Should return $result if pci address is $pci', ({ pci, result }) => {
    expect(validators.validatePciAddress(pci)).toEqual(result);
  });
});

describe('validateIfcName', () => {
  it.each`
        name                         | result
        ${'eth0'}                    | ${true}
        ${'lo0'}                     | ${true}
        ${'enp0s3'}                  | ${true}
        ${'maxIfNameLength'}         | ${true}
        ${null}                      | ${false}
        ${undefined}                 | ${false}
        ${''}                        | ${false}
        ${'eth-0'}                   | ${false}
        ${'eth\0'}                   | ${false}
        ${'eth{0'}                   | ${false}
        ${'tooLongInterfaceName'}    | ${false}
  `('Should return $result if interface name is $name', ({ name, result }) => {
    expect(validators.validateIfcName(name)).toEqual(result);
  });
});

describe('validateDriverName', () => {
  const maxDriverLengthName = 'ifc-driver-maximal-length-name';
  const tooLongDriverName = 'a-too-long-interface-driver-name';
  it.each`
        name                         | result
        ${'e1000'}                   | ${true}
        ${'fm10k'}                   | ${true}
        ${'igb'}                     | ${true}
        ${'igb-1000'}                | ${true}
        ${maxDriverLengthName}       | ${true}
        ${null}                      | ${false}
        ${undefined}                 | ${false}
        ${''}                        | ${false}
        ${'driver@'}                 | ${false}
        ${'driver\0'}                | ${false}
        ${'driver{0'}                | ${false}
        ${tooLongDriverName}         | ${false}
  `('Should return $result if driver name is $name', ({ name, result }) => {
    expect(validators.validateDriverName(name)).toEqual(result);
  });
});

describe('validateMacAddress', () => {
  it.each`
        addr                         | result
        ${'0a:00:0c:40:53:05'}       | ${true}
        ${'0a-00-0c-40-53-05'}       | ${true}
        ${'0A-0B-0C-0D-0E-0F'}       | ${true}
        ${null}                      | ${false}
        ${undefined}                 | ${false}
        ${''}                        | ${false}
        ${'0A-0B-0C'}                | ${false}
        ${'0A-0B-0C-0D-oE-0F-0G'}    | ${false}
        ${'0a:00:0t:40:53:05'}       | ${false}
        ${'0A_0B_0C_0D_0E_0F'}       | ${false}
        ${'0a-00-0c-40-53:05'}       | ${false}
        ${'0A0B0C0D0E0F'}            | ${false}
  `('Should return $result if MAC address is $addr', ({ addr, result }) => {
    expect(validators.validateMacAddress(addr)).toEqual(result);
  });
});

describe('validateRoutingProto', () => {
  it.each`
        protocol                     | result
        ${'OSPF'}                    | ${true}
        ${'ospf'}                    | ${true}
        ${'None'}                    | ${true}
        ${null}                      | ${false}
        ${undefined}                 | ${false}
        ${''}                        | ${false}
        ${'invalid-protocol'}        | ${false}
  `('Should return $result if protocol is $protocol', ({ protocol, result }) => {
    expect(validators.validateRoutingProto(protocol)).toEqual(result);
  });
});

describe('validateIfcType', () => {
  it.each`
        type                    | result
        ${'WAN'}                | ${true}
        ${'wan'}                | ${true}
        ${'LAN'}                | ${true}
        ${'lAn'}                | ${true}
        ${'None'}               | ${true}
        ${null}                 | ${false}
        ${undefined}            | ${false}
        ${''}                   | ${false}
        ${'invalid-type'}       | ${false}
  `('Should return $result if interface type is $type', ({ type, result }) => {
    expect(validators.validateIfcType(type)).toEqual(result);
  });
});

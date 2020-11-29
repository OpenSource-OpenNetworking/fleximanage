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

const { ObjectId } = require('mongoose').Types;
const { validateDevice, validateModifyDeviceMsg } = require('../validators');
const maxMetric = 2 * 10 ** 9;

describe('validateDevice', () => {
  let device;
  const successObject = {
    valid: true,
    err: ''
  };
  const failureObject = {
    valid: false,
    err: ''
  };

  beforeEach(() => {
    device = {
      interfaces: [{
        name: 'eth0',
        pciaddr: '00:02.00',
        driver: 'igb-1000',
        MAC: 'ab:45:90:ed:89:16',
        dhcp: 'no',
        IPv4: '192.168.100.1',
        IPv4Mask: '24',
        IPv6: '2001:db8:85a3:8d3:1319:8a2e:370:7348',
        IPv6Mask: '64',
        PublicIP: '72.168.10.30',
        PublicPort: '4789',
        NatType: '',
        useStun: true,
        gateway: '',
        metric: '',
        isAssigned: true,
        routing: 'OSPF',
        type: 'LAN',
        pathlabels: []
      },
      {
        name: 'eth1',
        pciaddr: '00:02.01',
        driver: 'igb-1000',
        MAC: 'ab:45:90:ed:89:17',
        dhcp: 'no',
        IPv4: '172.23.100.1',
        IPv4Mask: '24',
        IPv6: '2001:db8:85a3:8d3:1319:8a2e:370:7346',
        IPv6Mask: '64',
        PublicIP: '172.23.100.1',
        PublicPort: '4789',
        NatType: '',
        useStun: true,
        gateway: '172.23.100.10',
        metric: '0',
        isAssigned: true,
        routing: 'None',
        type: 'WAN',
        pathlabels: [ObjectId('5e65290fbe66a2335718e081')]
      }]
    };
  });

  // Happy path
  it('Should be a valid device', () => {
    const result = validateDevice(device);
    expect(result).toMatchObject(successObject);
  });

  it('Should ignore unassigned interfaces', () => {
    device.interfaces.push({
      name: 'eth0',
      pciaddr: '00:02.01',
      driver: 'igb-1000',
      MAC: 'ab:45:90:ed:89:17',
      dhcp: 'invalid-dhcp',
      IPv4: 'invalid-IPv4',
      IPv4Mask: 'invalid-mask',
      IPv6: 'invalid-IPv6',
      IPv6Mask: 'invalid-mask',
      isAssigned: false,
      routing: 'None',
      type: 'invalid-type'
    });
    const result = validateDevice(device);
    expect(result).toMatchObject(successObject);
  });

  it('Should be an invalid device if it has zero assigned LAN interfaces', () => {
    device.interfaces[0].type = 'Not-LAN';
    failureObject.err = 'There should be at least one LAN and one WAN interfaces';
    const result = validateDevice(device, true);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if it has zero assigned WAN interfaces', () => {
    device.interfaces[1].type = 'Not-WAN';
    failureObject.err = 'There should be at least one LAN and one WAN interfaces';
    const result = validateDevice(device, true);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if LAN IPv4 address is null', () => {
    device.interfaces[0].IPv4 = null;
    failureObject.err = `Interface ${device.interfaces[0].name} does not have an IP address`;
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if LAN IPv4 address is empty', () => {
    device.interfaces[0].IPv4 = '';
    failureObject.err = `Interface ${device.interfaces[0].name} does not have an IP address`;
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if LAN IPv4 mask is empty', () => {
    device.interfaces[0].IPv4Mask = '';
    failureObject.err = `Interface ${device.interfaces[0].name} does not have an IPv4 mask`;
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if both LAN IPv4 address and mask are empty', () => {
    device.interfaces[0].IPv4 = '';
    device.interfaces[0].IPv4Mask = '';
    failureObject.err = `Interface ${device.interfaces[0].name} does not have an IPv4 mask`;
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if WAN IPv4 address is null', () => {
    device.interfaces[0].IPv4 = null;
    failureObject.err = `Interface ${device.interfaces[0].name} does not have an IP address`;
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if WAN IPv4 address is empty', () => {
    device.interfaces[0].IPv4 = '';
    failureObject.err = `Interface ${device.interfaces[0].name} does not have an IP address`;
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if WAN IPv4 mask is empty', () => {
    device.interfaces[0].IPv4Mask = '';
    failureObject.err = `Interface ${device.interfaces[0].name} does not have an IPv4 mask`;
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if both WAN IPv4 address and mask are empty', () => {
    device.interfaces[0].IPv4 = '';
    device.interfaces[0].IPv4Mask = '';
    failureObject.err = `Interface ${device.interfaces[0].name} does not have an IPv4 mask`;
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if assigned interfaces are on the same subnet', () => {
    device.interfaces[0].IPv4 = '10.0.0.1';
    device.interfaces[1].IPv4 = '10.0.0.2';
    failureObject.err = 'IP addresses of the assigned interfaces have an overlap';
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an valid device if WAN and default GW IP addresses are not on the same subnet',
    () => {
      device.interfaces[1].IPv4 = '10.0.0.2';
      // failureObject.err = 'WAN and default route IP addresses are not on the same subnet';
      const result = validateDevice(device);
      expect(result).toMatchObject(successObject);
    });

  it('Should be an invalid device if OSPF is configured on the WAN interface', () => {
    device.interfaces[1].routing = 'OSPF';
    failureObject.err = 'OSPF should not be configured on WAN interface';
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if it has a LAN subnets overlap with other devices', () => {
    device.name = 'Device 1';
    device._id = '123456';
    const organizationLanSubnets = [
      { _id: '987', name: 'Device 2', subnet: '192.168.100.3' }
    ];

    const deviceSubnet = `${device.interfaces[0].IPv4}/${device.interfaces[0].IPv4Mask}`;
    const overlapsDeviceName = organizationLanSubnets[0].name;
    failureObject.err =
    `The LAN subnet ${deviceSubnet} overlaps with a LAN subnet of device ${overlapsDeviceName}`;

    const result = validateDevice(device, true, organizationLanSubnets);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be a valid device if it doesn\'t have a LAN subnets overlap', () => {
    device.name = 'Device 1';
    device._id = '123456';
    const organizationLanSubnets = [
      { _id: '987', name: 'Device 2', subnet: '192.168.88.3' }
    ];
    const result = validateDevice(device, true, organizationLanSubnets);
    expect(result).toMatchObject(successObject);
  });

  it('Should be an invalid device if WAN interface is not assigned a GW', () => {
    delete device.interfaces[1].gateway;
    failureObject.err = 'All WAN interfaces should be assigned a default GW';
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if WAN interface\'s GW is invalid', () => {
    device.interfaces[1].gateway = 'invalid-ip-address';
    failureObject.err = 'All WAN interfaces should be assigned a default GW';
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if LAN interface is assigned a GW', () => {
    device.interfaces[0].gateway = '10.0.0.100';
    failureObject.err = 'LAN interfaces should not be assigned a default GW';
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if LAN interface has path labels', () => {
    device.interfaces[0].pathlabels = [ObjectId('5e65290fbe66a2335718e081')];
    failureObject.err = 'Path Labels are not allowed on LAN interfaces';
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if metric is higher than maxMetric', () => {
    device.interfaces[1].metric = maxMetric + 1;
    failureObject.err = `Metric should be lower than ${maxMetric}`;
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if metric on WAN VPP interfaces is duplicated', () => {
    device.interfaces[0].pathlabels = [];
    device.interfaces.push({
      name: 'eth2',
      pciaddr: '00:03.01',
      driver: 'igb-1000',
      MAC: 'ab:45:90:ed:89:18',
      dhcp: 'no',
      IPv4: '172.23.102.1',
      IPv4Mask: '24',
      PublicIP: '172.23.102.1',
      PublicPort: '4789',
      NatType: '',
      useStun: true,
      gateway: '172.23.102.10',
      metric: '',
      isAssigned: true,
      routing: 'None',
      type: 'WAN',
      pathlabels: []
    });
    failureObject.err = 'Duplicated metrics are not allowed on VPP WAN interfaces';
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid device if interfaces are not of the array type', () => {
    device.interfaces = null;
    failureObject.err = 'There should be at least two interfaces';
    const result = validateDevice(device);
    expect(result).toMatchObject(failureObject);
  });
});

describe('validateModifyDeviceMsg', () => {
  let modifyDevMsg;
  const successObject = {
    valid: true,
    err: ''
  };
  const failureObject = {
    valid: false,
    err: ''
  };

  beforeEach(() => {
    modifyDevMsg = [
      {
        pci: '0000:00:03.00',
        addr: '10.0.0.101/24',
        addr6: 'fe80::a00:27ff:fe8d:fbbc/64',
        routing: 'NONE',
        type: 'WAN'
      },
      {
        pci: '0000:00:08.00',
        addr: '192.168.56.100/24',
        addr6: 'fe80::a00:27ff:fe8d:fbbc/64',
        routing: 'OSPF',
        type: 'LAN'
      }
    ];
  });

  // Happy path
  // Single interface
  it('Should be a valid message', () => {
    const result = validateModifyDeviceMsg(modifyDevMsg);
    expect(result).toMatchObject(successObject);
  });

  // Array of interfaces
  it('Should be a valid if message contains a single interface', () => {
    const singleIfc = {
      pci: '0000:00:03.00',
      addr: '10.0.0.101/24',
      addr6: 'fe80::a00:27ff:fe8d:fbbc/64',
      routing: 'NONE',
      type: 'WAN'
    };
    const result = validateModifyDeviceMsg(singleIfc);
    expect(result).toMatchObject(successObject);
  });

  // Empty array
  it('Should be a valid message contains no interfaces', () => {
    const emptyArray = [];
    const result = validateModifyDeviceMsg(emptyArray);
    expect(result).toMatchObject(successObject);
  });

  it('Should be an invalid message if IPv4 address contains double /', () => {
    modifyDevMsg[0].addr = '10.0.0.1//24';
    failureObject.err = `Bad request: Invalid IP address ${modifyDevMsg[0].addr}`;
    const result = validateModifyDeviceMsg(modifyDevMsg);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid message if IPv4 address is missing', () => {
    modifyDevMsg[0].addr = '/24';
    failureObject.err = `Bad request: Invalid IP address ${modifyDevMsg[0].addr}`;
    const result = validateModifyDeviceMsg(modifyDevMsg);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid message if IPv4 mask is missing', () => {
    modifyDevMsg[0].addr = '10.0.0.1';
    failureObject.err = `Bad request: Invalid IP address ${modifyDevMsg[0].addr}`;
    const result = validateModifyDeviceMsg(modifyDevMsg);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid message if both IPv4 address and mask are missing', () => {
    modifyDevMsg[0].addr = null;
    failureObject.err = `Bad request: Invalid IP address ${modifyDevMsg[0].addr}`;
    const result = validateModifyDeviceMsg(modifyDevMsg);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid message if IPv4 address is invalid', () => {
    modifyDevMsg[0].addr = '10.0.0./24';
    failureObject.err = `Bad request: Invalid IP address ${modifyDevMsg[0].addr}`;
    const result = validateModifyDeviceMsg(modifyDevMsg);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid message if IPv4 mask is invalid', () => {
    modifyDevMsg[0].addr = '10.0.0.1/123';
    failureObject.err = `Bad request: Invalid IP address ${modifyDevMsg[0].addr}`;
    const result = validateModifyDeviceMsg(modifyDevMsg);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid message if both IPv4 address and mask are invalid', () => {
    modifyDevMsg[0].addr = '10.0.0./345';
    failureObject.err = `Bad request: Invalid IP address ${modifyDevMsg[0].addr}`;
    const result = validateModifyDeviceMsg(modifyDevMsg);
    expect(result).toMatchObject(failureObject);
  });

  it('Should be an invalid message if one of the interfaces is invalid', () => {
    modifyDevMsg[1].addr = '';
    failureObject.err = `Bad request: Invalid IP address ${modifyDevMsg[1].addr}`;
    const result = validateModifyDeviceMsg(modifyDevMsg);
    expect(result).toMatchObject(failureObject);
  });
});

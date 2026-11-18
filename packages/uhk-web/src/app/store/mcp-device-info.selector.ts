import { createSelector } from '@ngrx/store';
import type { McpDeviceInfo } from '../mcp/tool-handler';
import type { State as DeviceState } from './reducers/device';

type McpDeviceState = Pick<DeviceState,
    'deviceConnectionStateLoaded' | 'connectedDevice' | 'hasPermission' | 'communicationInterfaceAvailable' |
    'bootloaderActive' | 'modules' | 'halvesInfo'>;

export const getMcpDeviceInfo = createSelector(
    (state: { device: McpDeviceState }) => state.device,
    (device): McpDeviceInfo | undefined => {
        if (!device.deviceConnectionStateLoaded) {
            return undefined;
        }

        if (!device.connectedDevice || !device.communicationInterfaceAvailable || !device.hasPermission || device.bootloaderActive) {
            return {
                connected: false,
                model: null,
                firmwareVersion: null,
                halves: { left: false, right: false, merged: false },
            };
        }

        return {
            connected: true,
            model: device.connectedDevice.name,
            firmwareVersion: device.modules.rightModuleInfo?.firmwareVersion || null,
            halves: {
                left: device.halvesInfo.isLeftHalfConnected,
                right: true,
                merged: device.halvesInfo.areHalvesMerged,
            },
        };
    }
);

export const mockSonyBlurayHost = '192.168.0.200'
export const mockSonyBlurayMac = 'A0:B1:C2:D3:E4:F5'

export const mockSonyIrccXml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <friendlyName>Court Sony UHD Blu-ray</friendlyName>
    <manufacturer>Sony Corporation</manufacturer>
    <modelName>UBP-X800M2</modelName>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <serviceList>
      <service>
        <serviceType>urn:schemas-sony-com:service:IRCC:1</serviceType>
        <serviceId>urn:schemas-sony-com:serviceId:IRCC</serviceId>
        <SCPDURL>/IRCCSCPD.xml</SCPDURL>
        <controlURL>/upnp/control/IRCC</controlURL>
      </service>
    </serviceList>
  </device>
</root>`

export const mockSonyActionListXml = `<?xml version="1.0"?>
<actionList>
  <action>
    <name>register</name>
    <mode>4</mode>
    <url>http://192.168.0.200:50002/register</url>
  </action>
  <action>
    <name>getRemoteCommandList</name>
    <url>http://192.168.0.200:50002/getRemoteCommandList</url>
  </action>
</actionList>`

export const mockSonyDmrXml = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:av="urn:schemas-sony-com:av">
  <device>
    <friendlyName>Court Sony UHD Blu-ray</friendlyName>
    <manufacturer>Sony Corporation</manufacturer>
    <modelName>UBP-X800M2</modelName>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <av:X_IRCC_DeviceInfo>
      <av:X_IRCC_Version>1.0</av:X_IRCC_Version>
    </av:X_IRCC_DeviceInfo>
    <serviceList>
      <service>
        <serviceType>urn:schemas-sony-com:service:IRCC:1</serviceType>
        <controlURL>/upnp/control/IRCC</controlURL>
      </service>
    </serviceList>
  </device>
</root>`

export const mockSonyCameraXml = `<?xml version="1.0"?>
<root>
  <device>
    <friendlyName>bisyamon</friendlyName>
    <manufacturer>Sony Corporation</manufacturer>
    <modelName>SonyCamera</modelName>
  </device>
</root>`

export const mockSonyIrccSoapOk = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:X_SendIRCCResponse xmlns:u="urn:schemas-sony-com:service:IRCC:1"></u:X_SendIRCCResponse>
  </s:Body>
</s:Envelope>`

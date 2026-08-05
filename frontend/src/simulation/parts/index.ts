export * from './PartSimulationRegistry';
export * from './ActiveParts';
// Side-effect imports — each of these files registers entries into the
// PartSimulationRegistry on module load. ActiveParts must run too so that
// semiconductors are marked self-managed (see the file header for why).
import './ActiveParts';
import './BasicParts';
import './ComplexParts';
import './ChipParts';
import './SensorParts';
import './GpsParts';
import './MotorDriverParts';
import './LogicGateParts';
import './ProtocolParts';
import './CustomChipPart';
import './EPaperPart';
// Side-effect: installs the runtime burnout monitor (P4) on the live solver.
import './runtimeBurnout';

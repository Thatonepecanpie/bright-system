import {registerRoot, Composition} from 'remotion';
import {Promo} from './Promo.jsx';
const Root = () => (
  <>
    <Composition id="Promo" component={Promo} durationInFrames={90} fps={30} width={1280} height={720} />
  </>
);
registerRoot(Root);

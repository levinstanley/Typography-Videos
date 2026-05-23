import "./index.css";
import {Composition} from "remotion";
import {OneWordAudioVideo} from "./Composition";

const fps = 30;
const durationInSeconds = 36;

export const RemotionRoot: React.FC = () => {
	return (
		<Composition
			id="OneWordAudioVideo"
			component={OneWordAudioVideo}
			durationInFrames={Math.ceil(durationInSeconds * fps)}
			fps={fps}
			width={1920}
			height={1080}
		/>
	);
};

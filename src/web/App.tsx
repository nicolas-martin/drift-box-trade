import { useEffect } from 'react';
import { SoundProvider } from 'react-sounds';
import { OrderSounds } from './sounds/OrderSounds';
import { attachOrderHandlers } from './orders/handlers';
import { L2 } from './pages/L2';

function App() {
	// Attach default order handlers once
	useEffect(() => {
		const detach = attachOrderHandlers();
		return () => detach();
	}, []);

	return (
		<SoundProvider>
			<div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
				<OrderSounds />
				<L2 />
			</div>
		</SoundProvider>
	);
}

export default App;

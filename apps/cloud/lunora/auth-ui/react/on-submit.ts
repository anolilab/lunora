/** Stop the browser's native submit and run the controller action (async or not). */
const onSubmit =
    (action: () => unknown) =>
    (event: { preventDefault: () => void }): void => {
        event.preventDefault();
        void action();
    };

export { onSubmit };
